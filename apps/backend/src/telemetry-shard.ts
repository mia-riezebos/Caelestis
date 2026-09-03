import { DurableObject } from 'cloudflare:workers'
import { type Millis, millis, type Seconds, seconds } from '@caelestis/shared'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  addCounters,
  type CounterDelta,
  type CounterValues,
  canAccumulateCounters,
  EXPIRES_AFTER_SECONDS,
  FLUSH_BATCH_LIMIT,
  FLUSHABLE_AFTER_SECONDS,
  isValidCounterDelta,
  MAX_COUNTER_DELTAS_PER_RECORD,
  type PendingCounters,
  RESOLUTION_SECONDS,
  type TelemetryBucket,
} from './ports/index.js'

const INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS = 1_000
const MAX_FLUSH_RETRY_DELAY_MILLISECONDS = 60_000
// The counters query binds every id twice. Stay below SQLite's conservative 999-variable default,
// not merely workerd's current higher limit, so large manifest groups remain portable.
const READ_PENDING_CHUNK_SIZE = 400

const flushRetryDelay = (failureCount: number): number =>
  Math.min(
    INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS * 2 ** Math.max(0, failureCount - 1),
    MAX_FLUSH_RETRY_DELAY_MILLISECONDS,
  )

/**
 * Row shapes for `storage.sql.exec<T>`, which constrains `T` to `Record<string, SqlStorageValue>` —
 * hence the index signature on each.
 */
interface CounterValuesRow {
  readonly [column: string]: SqlStorageValue
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

interface CounterRow extends CounterValuesRow {
  readonly template_id: string
  readonly bucket_start_s: Seconds
}

interface FlushedAtRow {
  readonly [column: string]: SqlStorageValue
  readonly template_id: string
  readonly flushed_at: Millis
}

interface CountRow {
  readonly [column: string]: SqlStorageValue
  readonly count: number
}

interface NextBucketRow {
  readonly [column: string]: SqlStorageValue
  readonly bucket_start_s: Seconds | null
}

// SqlStorage's variadic bind API accepts every numeric unit. Route timestamp values through these
// unit-specific adapters so a seconds/milliseconds swap is rejected before it reaches that API.
const bindSeconds = (value: Seconds): SqlStorageValue => value
const bindMillis = (value: Millis): SqlStorageValue => value

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed > 0 || correct > 0 || repairs > 0

const eventBucketStart = (occurredAt: Seconds): Seconds =>
  seconds(Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS)

export class TelemetryShard extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly clock: () => Millis = () => millis(Date.now()),
  ) {
    super(ctx, env)

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema()
      const nowMilliseconds = this.clock()
      this.pruneRetained(seconds(Math.floor(nowMilliseconds / 1_000)))
      await this.scheduleNextAlarm(nowMilliseconds)
    })
  }

  async record(deltas: readonly CounterDelta[], idempotencyKey?: string): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = seconds(Math.floor(nowMilliseconds / 1_000))
    // A successful flush leaves retained reconciliation state but no alarm. The next write is a
    // lifecycle opportunity to reclaim expired rows that no pending or flush-batch state needs.
    this.pruneRetained(nowSeconds)

    this.ctx.storage.transactionSync(() => {
      if (idempotencyKey !== undefined) {
        const claimed = this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO applied_counter_events (event_id, seen_at_ms) VALUES (?1, ?2)`,
          idempotencyKey,
          bindMillis(nowMilliseconds),
        )
        if (claimed.rowsWritten === 0) return
      }

      const boundedDeltas = deltas.slice(0, MAX_COUNTER_DELTAS_PER_RECORD)
      let droppedLate = deltas.length - boundedDeltas.length
      const outstandingByTemplate = new Map<string, CounterValues>()
      const cumulativeByBucket = new Map<string, CounterValues>()

      for (const delta of boundedDeltas) {
        // Keep one operational counter for all rejected input: both malformed and out-of-window
        // deltas have the same outcome and remediation, and splitting them would add schema surface.
        if (!isValidCounterDelta(delta, nowSeconds)) {
          droppedLate += 1
          continue
        }
        if (!hasActivity(delta)) continue

        const bucketStart = eventBucketStart(delta.occurredAt)
        const key = `${delta.templateId}\u0000${bucketStart}`
        const outstanding =
          outstandingByTemplate.get(delta.templateId) ??
          this.readOutstandingCounters(delta.templateId)
        const cumulative =
          cumulativeByBucket.get(key) ?? this.readCumulativeBucket(delta.templateId, bucketStart)
        if (
          !canAccumulateCounters(outstanding, delta) ||
          !canAccumulateCounters(cumulative, delta)
        ) {
          droppedLate += 1
          continue
        }
        this.ctx.storage.sql.exec(
          `
          INSERT INTO pending_counters (
            template_id, bucket_start_s, placed, correct, repairs
          ) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT (template_id, bucket_start_s) DO UPDATE SET
            placed = placed + excluded.placed,
            correct = correct + excluded.correct,
            repairs = repairs + excluded.repairs
        `,
          delta.templateId,
          bindSeconds(bucketStart),
          delta.placed,
          delta.correct,
          delta.repairs,
        )
        outstandingByTemplate.set(delta.templateId, addCounters(outstanding, delta))
        cumulativeByBucket.set(key, addCounters(cumulative, delta))
      }

      this.pruneZeroPending()

      if (droppedLate > 0) {
        this.ctx.storage.sql.exec(
          `
          UPDATE counter_stats
          SET dropped_late_deltas = dropped_late_deltas + ?1
          WHERE singleton = 1
        `,
          droppedLate,
        )
      }
    })

    await this.scheduleNextAlarm(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    await this.scheduleNextAlarm(this.clock())
    if (templateIds.length === 0) return []

    const countersByTemplate = new Map<string, CounterRow>()
    const flushedAtByTemplate = new Map<string, Millis>()
    for (let offset = 0; offset < templateIds.length; offset += READ_PENDING_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_PENDING_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(', ')
      const counters = this.ctx.storage.sql
        .exec<CounterRow>(
          `
          SELECT
            template_id,
            0 AS bucket_start_s,
            SUM(placed) AS placed,
            SUM(correct) AS correct,
            SUM(repairs) AS repairs
          FROM (
            SELECT template_id, placed, correct, repairs
            FROM pending_counters
            WHERE template_id IN (${placeholders})
            UNION ALL
            SELECT
              batch.template_id,
              batch.placed - COALESCE(retained.placed, 0),
              batch.correct - COALESCE(retained.correct, 0),
              batch.repairs - COALESCE(retained.repairs, 0)
            FROM flush_batch AS batch
            LEFT JOIN retained_counters AS retained
              ON retained.template_id = batch.template_id
             AND retained.bucket_start_s = batch.bucket_start_s
            WHERE batch.template_id IN (${placeholders})
          )
          GROUP BY template_id
        `,
          ...chunk,
          ...chunk,
        )
        .toArray()
      const metadata = this.ctx.storage.sql
        .exec<FlushedAtRow>(
          `
          SELECT template_id, flushed_at
          FROM counter_meta
          WHERE template_id IN (${placeholders})
        `,
          ...chunk,
        )
        .toArray()
      for (const row of counters) countersByTemplate.set(row.template_id, row)
      for (const row of metadata) flushedAtByTemplate.set(row.template_id, row.flushed_at)
    }

    return templateIds.map((templateId) => {
      const row = countersByTemplate.get(templateId)
      const flushedAt = flushedAtByTemplate.get(templateId)
      return {
        templateId,
        placed: row?.placed ?? 0,
        correct: row?.correct ?? 0,
        repairs: row?.repairs ?? 0,
        flushedAt: flushedAt ?? null,
      }
    })
  }

  async readDroppedLateCount(): Promise<number> {
    return this.ctx.storage.sql
      .exec<CountRow>(
        `
          SELECT dropped_late_deltas AS count
          FROM counter_stats
          WHERE singleton = 1
        `,
      )
      .one().count
  }

  async readFlushFailureCount(): Promise<number> {
    return this.ctx.storage.sql
      .exec<CountRow>(
        'SELECT consecutive_failures AS count FROM flush_retry_state WHERE singleton = 1',
      )
      .one().count
  }

  override async alarm(): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = seconds(Math.floor(nowMilliseconds / 1_000))

    this.pruneRetained(nowSeconds)
    this.pruneZeroPending()
    let rows = this.readFlushBatch()

    if (rows.length === 0) {
      // Pending activity accumulated during a failed D1 write stays put. Once the preserved batch
      // succeeds and clears, the next alarm promotes and drains that pending activity.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `
            INSERT INTO flush_batch (
              template_id, bucket_start_s, placed, correct, repairs
            )
            SELECT
              pending.template_id,
              pending.bucket_start_s,
              pending.placed + COALESCE(retained.placed, 0),
              pending.correct + COALESCE(retained.correct, 0),
              pending.repairs + COALESCE(retained.repairs, 0)
            FROM pending_counters AS pending
            LEFT JOIN retained_counters AS retained
              ON retained.template_id = pending.template_id
             AND retained.bucket_start_s = pending.bucket_start_s
            WHERE pending.bucket_start_s + ?1 <= ?2
              AND (pending.placed <> 0 OR pending.correct <> 0 OR pending.repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          bindSeconds(nowSeconds),
        )
        this.ctx.storage.sql.exec(
          `
            DELETE FROM pending_counters
            WHERE bucket_start_s + ?1 <= ?2
              AND (placed <> 0 OR correct <> 0 OR repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          bindSeconds(nowSeconds),
        )
      })
      rows = this.readFlushBatch()
    }

    if (rows.length > 0) {
      const buckets: readonly TelemetryBucket[] = rows.map((row) => ({
        templateId: row.template_id,
        resolution: RESOLUTION_SECONDS,
        bucketStart: row.bucket_start_s,
        placed: row.placed,
        correct: row.correct,
        repairs: row.repairs,
      }))

      // D1 must commit before retained_counters advances. Advancing retained first makes
      // readPending subtract the batch from itself and report zero for an unbounded D1 outage.
      //
      // The cost, stated accurately: if D1 commits but the response is lost, retained does not
      // advance, so readPending keeps counting a batch D1 already holds and live totals read high
      // by that batch. This is NOT a one-alarm window — it persists until the next flush succeeds,
      // which during an outage means the whole outage, at up to 60s per retry. It always heals.
      //
      // Reporting high while recovering beats reporting zero for the duration, which is what the
      // opposite ordering does. Both are wrong; only one of them is wrong in a direction that hides
      // work rather than exaggerating it.
      try {
        const sql = new D1SqlStore(this.env.DB)
        await sql.appendBuckets(buckets)
        await sql.foldTelemetryBuckets(
          buckets.map((bucket) => bucket.templateId),
          nowSeconds,
        )
      } catch (error) {
        // Schedule the retry and return normally rather than rethrowing.
        //
        // Cloudflare retries a throwing alarm() with exponential backoff "starting at a 2 second
        // delay from the first failure with up to 6 retries allowed", and its docs recommend
        // catching inside the handler and scheduling a new alarm "if you want to make sure your
        // alarm handler will be retried indefinitely". Rethrowing would cap recovery at six
        // attempts — a D1 outage longer than roughly two minutes would exhaust them and strand
        // flush_batch until unrelated traffic happened to re-arm the alarm. Owning the retry is the
        // whole reason the backoff exists.
        //
        // The failure is not silent: readFlushFailureCount() exposes the consecutive-failure count,
        // console.error records the cause, and the batch stays in flush_batch until D1 confirms.
        // Note what is given up — a throwing alarm() registers as a platform error that Cloudflare
        // retains and can alert on. Returning normally reports success while flushing nothing, so
        // the counter above is the replacement and has to be watched.
        // https://developers.cloudflare.com/durable-objects/api/alarms/
        const failureCount = this.incrementFlushFailureCount()
        const retryDelay = flushRetryDelay(failureCount)
        console.error(
          `telemetry flush failed (attempt ${failureCount}), retrying in ${retryDelay}ms`,
          error,
        )
        await this.ctx.storage.setAlarm(millis(this.clock() + retryDelay))
        return
      }

      this.ctx.storage.transactionSync(() => {
        this.resetFlushFailureCount()
        for (const row of rows) {
          this.ctx.storage.sql.exec(
            `
              INSERT INTO retained_counters (
                template_id, bucket_start_s, placed, correct, repairs
              ) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (template_id, bucket_start_s) DO UPDATE SET
                placed = excluded.placed,
                correct = excluded.correct,
                repairs = excluded.repairs
            `,
            row.template_id,
            bindSeconds(row.bucket_start_s),
            row.placed,
            row.correct,
            row.repairs,
          )
          this.ctx.storage.sql.exec(
            `
              INSERT INTO counter_meta (template_id, flushed_at)
              VALUES (?1, ?2)
              ON CONFLICT (template_id) DO UPDATE SET flushed_at = excluded.flushed_at
            `,
            row.template_id,
            bindMillis(nowMilliseconds),
          )
          this.ctx.storage.sql.exec(
            'DELETE FROM flush_batch WHERE template_id = ?1 AND bucket_start_s = ?2',
            row.template_id,
            bindSeconds(row.bucket_start_s),
          )
        }
      })
    }

    this.pruneRetained(nowSeconds)
    await this.scheduleNextAlarm(nowMilliseconds)
  }

  /**
   * Runs on every cold start, so it stays a plain set of idempotent creates.
   *
   * There is no in-place schema migration here on purpose. Nothing has been deployed, so no Durable
   * Object anywhere holds an older shape — the only such state is local miniflare state, which is
   * disposable. Once this *is* deployed, changing these tables will need a real migration story, and
   * that belongs in a ticket rather than in an untested branch nobody has ever executed.
   */
  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_counters (
        template_id TEXT NOT NULL,
        bucket_start_s INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start_s)
      );
      CREATE TABLE IF NOT EXISTS flush_batch (
        template_id TEXT NOT NULL,
        bucket_start_s INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start_s)
      );
      CREATE TABLE IF NOT EXISTS retained_counters (
        template_id TEXT NOT NULL,
        bucket_start_s INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start_s)
      );
      CREATE TABLE IF NOT EXISTS counter_meta (
        template_id TEXT PRIMARY KEY,
        flushed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counter_stats (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        dropped_late_deltas INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO counter_stats (singleton, dropped_late_deltas) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS flush_retry_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        consecutive_failures INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO flush_retry_state (singleton, consecutive_failures) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS applied_counter_events (
        event_id TEXT PRIMARY KEY,
        seen_at_ms INTEGER NOT NULL
      );
    `)
  }

  private readFlushBatch(): CounterRow[] {
    return this.ctx.storage.sql
      .exec<CounterRow>(
        `
          SELECT template_id, bucket_start_s, placed, correct, repairs
          FROM flush_batch
          ORDER BY template_id, bucket_start_s
          LIMIT ?1
        `,
        FLUSH_BATCH_LIMIT,
      )
      .toArray()
  }

  /** Current unflushed amount exposed by `readPending` for one template. */
  private readOutstandingCounters(templateId: string): CounterValues {
    return this.ctx.storage.sql
      .exec<CounterValuesRow>(
        `
          SELECT
            COALESCE(SUM(placed), 0) AS placed,
            COALESCE(SUM(correct), 0) AS correct,
            COALESCE(SUM(repairs), 0) AS repairs
          FROM (
            SELECT placed, correct, repairs
            FROM pending_counters
            WHERE template_id = ?1
            UNION ALL
            SELECT
              batch.placed - COALESCE(retained.placed, 0),
              batch.correct - COALESCE(retained.correct, 0),
              batch.repairs - COALESCE(retained.repairs, 0)
            FROM flush_batch AS batch
            LEFT JOIN retained_counters AS retained
              ON retained.template_id = batch.template_id
             AND retained.bucket_start_s = batch.bucket_start_s
            WHERE batch.template_id = ?1
          )
        `,
        templateId,
      )
      .one()
  }

  /** Full cumulative bucket value after pending work eventually joins retained or flushing work. */
  private readCumulativeBucket(templateId: string, bucketStart: Seconds): CounterValues {
    return this.ctx.storage.sql
      .exec<CounterValuesRow>(
        `
          SELECT
            COALESCE((
              SELECT placed FROM pending_counters
              WHERE template_id = ?1 AND bucket_start_s = ?2
            ), 0) + COALESCE(
              (SELECT placed FROM flush_batch
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              (SELECT placed FROM retained_counters
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              0
            ) AS placed,
            COALESCE((
              SELECT correct FROM pending_counters
              WHERE template_id = ?1 AND bucket_start_s = ?2
            ), 0) + COALESCE(
              (SELECT correct FROM flush_batch
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              (SELECT correct FROM retained_counters
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              0
            ) AS correct,
            COALESCE((
              SELECT repairs FROM pending_counters
              WHERE template_id = ?1 AND bucket_start_s = ?2
            ), 0) + COALESCE(
              (SELECT repairs FROM flush_batch
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              (SELECT repairs FROM retained_counters
               WHERE template_id = ?1 AND bucket_start_s = ?2),
              0
            ) AS repairs
        `,
        templateId,
        bindSeconds(bucketStart),
      )
      .one()
  }

  private pruneRetained(nowSeconds: Seconds): void {
    this.ctx.storage.sql.exec(
      `
        DELETE FROM retained_counters
        WHERE bucket_start_s + ?1 <= ?2
          AND NOT EXISTS (
            SELECT 1
            FROM pending_counters
            WHERE pending_counters.template_id = retained_counters.template_id
              AND pending_counters.bucket_start_s = retained_counters.bucket_start_s
          )
          AND NOT EXISTS (
            SELECT 1
            FROM flush_batch
            WHERE flush_batch.template_id = retained_counters.template_id
              AND flush_batch.bucket_start_s = retained_counters.bucket_start_s
          )
      `,
      EXPIRES_AFTER_SECONDS,
      bindSeconds(nowSeconds),
    )
  }

  private pruneZeroPending(): void {
    // Defensive: valid deltas currently cannot create a zero row, but keep cleanup safe if input or
    // migration rules change later.
    this.ctx.storage.sql.exec(
      'DELETE FROM pending_counters WHERE placed = 0 AND correct = 0 AND repairs = 0',
    )
  }

  private async scheduleNextAlarm(nowMilliseconds: Millis): Promise<void> {
    const flushBatchCount = this.ctx.storage.sql
      .exec<CountRow>('SELECT COUNT(*) AS count FROM flush_batch')
      .one().count
    if (flushBatchCount > 0) {
      const scheduledAlarm = await this.ctx.storage.getAlarm()
      if (scheduledAlarm === null || scheduledAlarm <= nowMilliseconds) {
        await this.ctx.storage.setAlarm(nowMilliseconds)
      }
      return
    }

    const nextBucket = this.ctx.storage.sql
      .exec<NextBucketRow>(
        `
          SELECT MIN(bucket_start_s) AS bucket_start_s
          FROM pending_counters
          WHERE placed <> 0 OR correct <> 0 OR repairs <> 0
        `,
      )
      .one().bucket_start_s
    if (nextBucket === null) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    const flushableAtMilliseconds = millis((nextBucket + FLUSHABLE_AFTER_SECONDS) * 1_000)
    await this.ctx.storage.setAlarm(Math.max(nowMilliseconds, flushableAtMilliseconds))
  }

  private incrementFlushFailureCount(): number {
    const current = this.ctx.storage.sql
      .exec<CountRow>(
        'SELECT consecutive_failures AS count FROM flush_retry_state WHERE singleton = 1',
      )
      .one().count
    const next = current + 1
    this.ctx.storage.sql.exec(
      'UPDATE flush_retry_state SET consecutive_failures = ?1 WHERE singleton = 1',
      next,
    )
    return next
  }

  private resetFlushFailureCount(): void {
    this.ctx.storage.sql.exec(
      'UPDATE flush_retry_state SET consecutive_failures = 0 WHERE singleton = 1',
    )
  }
}
