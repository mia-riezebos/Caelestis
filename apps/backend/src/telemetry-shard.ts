import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import type { CounterDelta, TelemetryBucket, PendingCounters } from './ports/index.js'

const RESOLUTION_SECONDS = 60
const ALARM_DELAY_MILLISECONDS = 60_000

/**
 * Row shapes for `storage.sql.exec<T>`, which constrains `T` to `Record<string, SqlStorageValue>` —
 * hence the index signature on each.
 */
interface CounterRow {
  readonly [column: string]: SqlStorageValue
  readonly template_id: string
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

interface FlushRow extends CounterRow {
  readonly bucket_start: number
}

interface FlushedAtRow {
  readonly [column: string]: SqlStorageValue
  readonly template_id: string
  readonly flushed_at: number
}

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed !== 0 || correct !== 0 || repairs !== 0

export class TelemetryShard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pending_counters (
          template_id TEXT PRIMARY KEY,
          placed INTEGER NOT NULL,
          correct INTEGER NOT NULL,
          repairs INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flush_batch (
          template_id TEXT PRIMARY KEY,
          bucket_start INTEGER NOT NULL,
          placed INTEGER NOT NULL,
          correct INTEGER NOT NULL,
          repairs INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counter_meta (
          template_id TEXT PRIMARY KEY,
          flushed_at INTEGER NOT NULL
        );
      `)
    })
  }

  async record(deltas: readonly CounterDelta[]): Promise<void> {
    for (const delta of deltas) {
      if (!hasActivity(delta)) continue

      this.ctx.storage.sql.exec(
        `
          INSERT INTO pending_counters (template_id, placed, correct, repairs)
          VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT (template_id) DO UPDATE SET
            placed = placed + excluded.placed,
            correct = correct + excluded.correct,
            repairs = repairs + excluded.repairs
        `,
        delta.templateId,
        delta.placed,
        delta.correct,
        delta.repairs,
      )
    }

    if (!this.hasPendingActivity()) return

    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MILLISECONDS)
    }
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    if (templateIds.length === 0) return []

    const placeholders = templateIds.map(() => '?').join(', ')
    const counters = this.ctx.storage.sql
      .exec<CounterRow>(
        `
          SELECT
            template_id,
            SUM(placed) AS placed,
            SUM(correct) AS correct,
            SUM(repairs) AS repairs
          FROM (
            SELECT template_id, placed, correct, repairs
            FROM pending_counters
            WHERE template_id IN (${placeholders})
            UNION ALL
            SELECT template_id, placed, correct, repairs
            FROM flush_batch
            WHERE template_id IN (${placeholders})
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

  override async alarm(): Promise<void> {
    let rows = this.readFlushBatch()

    if (rows.length === 0) {
      const nowSeconds = Math.floor(Date.now() / 1_000)
      const bucketStart = Math.floor(nowSeconds / RESOLUTION_SECONDS) * RESOLUTION_SECONDS
      this.ctx.storage.sql.exec(
        `
          INSERT INTO flush_batch (
            template_id, bucket_start, placed, correct, repairs
          )
          SELECT template_id, ?1, placed, correct, repairs
          FROM pending_counters
          WHERE placed <> 0 OR correct <> 0 OR repairs <> 0
        `,
        bucketStart,
      )
      this.ctx.storage.sql.exec('DELETE FROM pending_counters')
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

      const flushedAt = Date.now()
      this.ctx.storage.sql.exec('DELETE FROM flush_batch')
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `
            INSERT INTO counter_meta (template_id, flushed_at)
            VALUES (?1, ?2)
            ON CONFLICT (template_id) DO UPDATE SET flushed_at = excluded.flushed_at
          `,
          row.template_id,
          flushedAt,
        )
      }
    }

    if (this.hasPendingActivity()) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MILLISECONDS)
    }
  }

  private readFlushBatch(): FlushRow[] {
    return this.ctx.storage.sql
      .exec<FlushRow>(
        `
          SELECT template_id, bucket_start, placed, correct, repairs
          FROM flush_batch
          ORDER BY template_id
        `,
      )
      .toArray()
  }

  private hasPendingActivity(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ readonly count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM pending_counters
          WHERE placed <> 0 OR correct <> 0 OR repairs <> 0
        `,
      )
      .one()
    return row.count > 0
  }
}
