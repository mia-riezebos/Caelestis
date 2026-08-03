import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import {
  type CounterDelta,
  GRACE_SECONDS,
  type PendingCounters,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
  type TelemetryBucket,
} from './ports/index.js'

const FLUSHABLE_AFTER_SECONDS = RESOLUTION_SECONDS + GRACE_SECONDS
const EXPIRES_AFTER_SECONDS = FLUSHABLE_AFTER_SECONDS + RETENTION_SECONDS

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
  placed !== 0 || correct !== 0 || repairs !== 0

const eventBucketStart = (occurredAt: number): number =>
  Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS

const expiresAt = (bucketStart: number): number => bucketStart + EXPIRES_AFTER_SECONDS

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
    let droppedLate = 0

    for (const delta of deltas) {
      if (!hasActivity(delta)) continue

      const bucketStart = eventBucketStart(delta.occurredAt)
      if (expiresAt(bucketStart) <= nowSeconds) {
        droppedLate += 1
        continue
      }

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

    this.pruneRetained(nowSeconds)
    await this.scheduleNextAlarm(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
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
    let rows = this.readFlushBatch()

    if (rows.length === 0) {
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

      await new D1SqlStore(this.env.DB).appendBuckets(buckets)

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
          this.ctx.storage.sql.exec(
            `
              INSERT INTO counter_meta (template_id, flushed_at)
              VALUES (?1, ?2)
              ON CONFLICT (template_id) DO UPDATE SET flushed_at = excluded.flushed_at
            `,
            row.template_id,
            nowMilliseconds,
          )
        }
        this.ctx.storage.sql.exec('DELETE FROM flush_batch')
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
    `)
  }

  private readFlushBatch(): CounterRow[] {
    return this.ctx.storage.sql
      .exec<CounterRow>(
        `
          SELECT template_id, bucket_start, placed, correct, repairs
          FROM flush_batch
          ORDER BY template_id, bucket_start
        `,
      )
      .toArray()
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

  private async scheduleNextAlarm(nowMilliseconds: number): Promise<void> {
    const flushBatchCount = this.ctx.storage.sql
      .exec<CountRow>('SELECT COUNT(*) AS count FROM flush_batch')
      .one().count
    if (flushBatchCount > 0) {
      await this.ctx.storage.setAlarm(nowMilliseconds)
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
}
