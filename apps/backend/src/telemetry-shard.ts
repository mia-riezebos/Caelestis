import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  type CounterDelta,
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

const flushRetryDelay = (failureCount: number): number =>
  Math.min(
    INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS * 2 ** Math.max(0, failureCount - 1),
    MAX_FLUSH_RETRY_DELAY_MILLISECONDS,
  )

/**
 * Row shapes for `storage.sql.exec<T>`, which constrains `T` to `Record<string, SqlStorageValue>` —
 * hence the index signature on each.
 */
interface CounterRow {
  readonly [column: string]: SqlStorageValue
  readonly template_id: string
  readonly bucket_start: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

interface FlushedAtRow {
  readonly [column: string]: SqlStorageValue
  readonly template_id: string
  readonly flushed_at: number
}

interface CountRow {
  readonly [column: string]: SqlStorageValue
  readonly count: number
}

interface NextBucketRow {
  readonly [column: string]: SqlStorageValue
  readonly bucket_start: number | null
}

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed > 0 || correct > 0 || repairs > 0

const eventBucketStart = (occurredAt: number): number =>
  Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS

export class TelemetryShard extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly clock: () => number = Date.now,
  ) {
    super(ctx, env)

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema()
      const nowMilliseconds = this.clock()
      this.pruneRetained(Math.floor(nowMilliseconds / 1_000))
      await this.scheduleNextAlarm(nowMilliseconds)
    })
  }

  async record(deltas: readonly CounterDelta[]): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = Math.floor(nowMilliseconds / 1_000)
    // Validation consults local traces, so sweep stale retained rows before asking that question.
    this.pruneRetained(nowSeconds)

    const boundedDeltas = deltas.slice(0, MAX_COUNTER_DELTAS_PER_RECORD)
    let droppedLate = deltas.length - boundedDeltas.length

    for (const delta of boundedDeltas) {
      // Keep one operational counter for all rejected input: both malformed and out-of-window
      // deltas have the same outcome and remediation, and splitting them would add schema surface.
      if (
        !isValidCounterDelta(delta, nowSeconds, (templateId, bucketStart) =>
          this.hasLocalTrace(templateId, bucketStart, nowSeconds),
        )
      ) {
        droppedLate += 1
        continue
      }
      if (!hasActivity(delta)) continue

      const bucketStart = eventBucketStart(delta.occurredAt)
      this.ctx.storage.sql.exec(
        `
          INSERT INTO pending_counters (
            template_id, bucket_start, placed, correct, repairs
          ) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT (template_id, bucket_start) DO UPDATE SET
            placed = placed + excluded.placed,
            correct = correct + excluded.correct,
            repairs = repairs + excluded.repairs
        `,
        delta.templateId,
        bucketStart,
        delta.placed,
        delta.correct,
        delta.repairs,
      )
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

    await this.scheduleNextAlarm(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    await this.scheduleNextAlarm(this.clock())
    if (templateIds.length === 0) return []

    const placeholders = templateIds.map(() => '?').join(', ')
    const counters = this.ctx.storage.sql
      .exec<CounterRow>(
        `
          SELECT
            template_id,
            0 AS bucket_start,
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
             AND retained.bucket_start = batch.bucket_start
            WHERE batch.template_id IN (${placeholders})
          )
          GROUP BY template_id
        `,
        ...templateIds,
        ...templateIds,
      )
      .toArray()
    const metadata = this.ctx.storage.sql
      .exec<FlushedAtRow>(
        `
          SELECT template_id, flushed_at
          FROM counter_meta
          WHERE template_id IN (${placeholders})
        `,
        ...templateIds,
      )
      .toArray()
    const countersByTemplate = new Map(counters.map((row) => [row.template_id, row]))
    const flushedAtByTemplate = new Map(metadata.map((row) => [row.template_id, row.flushed_at]))

    return templateIds.map((templateId) => {
      const row = countersByTemplate.get(templateId)
      return {
        templateId,
        placed: row?.placed ?? 0,
        correct: row?.correct ?? 0,
        repairs: row?.repairs ?? 0,
        flushedAt: flushedAtByTemplate.get(templateId) ?? null,
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

  override async alarm(): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = Math.floor(nowMilliseconds / 1_000)

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
              template_id, bucket_start, placed, correct, repairs
            )
            SELECT
              pending.template_id,
              pending.bucket_start,
              pending.placed + COALESCE(retained.placed, 0),
              pending.correct + COALESCE(retained.correct, 0),
              pending.repairs + COALESCE(retained.repairs, 0)
            FROM pending_counters AS pending
            LEFT JOIN retained_counters AS retained
              ON retained.template_id = pending.template_id
             AND retained.bucket_start = pending.bucket_start
            WHERE pending.bucket_start + ?1 <= ?2
              AND (pending.placed <> 0 OR pending.correct <> 0 OR pending.repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          nowSeconds,
        )
        this.ctx.storage.sql.exec(
          `
            DELETE FROM pending_counters
            WHERE bucket_start + ?1 <= ?2
              AND (placed <> 0 OR correct <> 0 OR repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          nowSeconds,
        )
      })
      rows = this.readFlushBatch()
    }

    if (rows.length > 0) {
      const buckets: readonly TelemetryBucket[] = rows.map((row) => ({
        templateId: row.template_id,
        resolution: RESOLUTION_SECONDS,
        bucketStart: row.bucket_start,
        placed: row.placed,
        correct: row.correct,
        repairs: row.repairs,
      }))

      // Publish the cumulative local value before the remote write. A crash can then only make the
      // live display transiently under-count; flush_batch remains the retry source until D1 confirms.
      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          this.ctx.storage.sql.exec(
            `
              INSERT INTO retained_counters (
                template_id, bucket_start, placed, correct, repairs
              ) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (template_id, bucket_start) DO UPDATE SET
                placed = excluded.placed,
                correct = excluded.correct,
                repairs = excluded.repairs
            `,
            row.template_id,
            row.bucket_start,
            row.placed,
            row.correct,
            row.repairs,
          )
        }
      })

      try {
        await new D1SqlStore(this.env.DB).appendBuckets(buckets)
      } catch (error) {
        const failureCount = this.incrementFlushFailureCount()
        await this.ctx.storage.setAlarm(nowMilliseconds + flushRetryDelay(failureCount))
        throw error
      }

      this.ctx.storage.transactionSync(() => {
        this.resetFlushFailureCount()
        for (const row of rows) {
          this.ctx.storage.sql.exec(
            `
              INSERT INTO counter_meta (template_id, flushed_at)
              VALUES (?1, ?2)
              ON CONFLICT (template_id) DO UPDATE SET flushed_at = excluded.flushed_at
            `,
            row.template_id,
            nowMilliseconds,
          )
          this.ctx.storage.sql.exec(
            'DELETE FROM flush_batch WHERE template_id = ?1 AND bucket_start = ?2',
            row.template_id,
            row.bucket_start,
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
        bucket_start INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start)
      );
      CREATE TABLE IF NOT EXISTS flush_batch (
        template_id TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start)
      );
      CREATE TABLE IF NOT EXISTS retained_counters (
        template_id TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        placed INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        repairs INTEGER NOT NULL,
        PRIMARY KEY (template_id, bucket_start)
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
    `)
  }

  private readFlushBatch(): CounterRow[] {
    return this.ctx.storage.sql
      .exec<CounterRow>(
        `
          SELECT template_id, bucket_start, placed, correct, repairs
          FROM flush_batch
          ORDER BY template_id, bucket_start
          LIMIT ?1
        `,
        FLUSH_BATCH_LIMIT,
      )
      .toArray()
  }

  private hasLocalTrace(templateId: string, bucketStart: number, nowSeconds: number): boolean {
    // A local row may rescue an event exactly at the retention edge, but it must never keep a
    // long-dead bucket admissible throughout an extended outage.
    if (bucketStart + EXPIRES_AFTER_SECONDS < nowSeconds) return false

    return (
      this.ctx.storage.sql
        .exec<CountRow>(
          `
            SELECT COUNT(*) AS count
            FROM (
              SELECT 1
              FROM pending_counters
              WHERE template_id = ?1 AND bucket_start = ?2
              UNION ALL
              SELECT 1
              FROM flush_batch
              WHERE template_id = ?1 AND bucket_start = ?2
              UNION ALL
              SELECT 1
              FROM retained_counters
              WHERE template_id = ?1 AND bucket_start = ?2
            )
          `,
          templateId,
          bucketStart,
        )
        .one().count > 0
    )
  }

  private pruneRetained(nowSeconds: number): void {
    this.ctx.storage.sql.exec(
      `
        DELETE FROM retained_counters
        WHERE bucket_start + ?1 <= ?2
          AND NOT EXISTS (
            SELECT 1
            FROM pending_counters
            WHERE pending_counters.template_id = retained_counters.template_id
              AND pending_counters.bucket_start = retained_counters.bucket_start
          )
          AND NOT EXISTS (
            SELECT 1
            FROM flush_batch
            WHERE flush_batch.template_id = retained_counters.template_id
              AND flush_batch.bucket_start = retained_counters.bucket_start
          )
      `,
      EXPIRES_AFTER_SECONDS,
      nowSeconds,
    )
  }

  private pruneZeroPending(): void {
    // Defensive: valid deltas currently cannot create a zero row, but keep cleanup safe if input or
    // migration rules change later.
    this.ctx.storage.sql.exec(
      'DELETE FROM pending_counters WHERE placed = 0 AND correct = 0 AND repairs = 0',
    )
  }

  private async scheduleNextAlarm(nowMilliseconds: number): Promise<void> {
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
          SELECT MIN(bucket_start) AS bucket_start
          FROM pending_counters
          WHERE placed <> 0 OR correct <> 0 OR repairs <> 0
        `,
      )
      .one().bucket_start
    if (nextBucket === null) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    const flushableAtMilliseconds = (nextBucket + FLUSHABLE_AFTER_SECONDS) * 1_000
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
