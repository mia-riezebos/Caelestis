import type { BucketQuery, SqlStore, TelemetryBucket } from '../../ports/index.js'

interface TelemetryBucketRow {
  readonly template_id: string
  readonly resolution: number
  readonly bucket_start: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

const APPEND_BUCKET = `
  INSERT INTO telemetry_buckets (
    template_id, resolution, bucket_start, placed, correct, repairs
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (template_id, resolution, bucket_start) DO UPDATE SET
    placed = excluded.placed,
    correct = excluded.correct,
    repairs = excluded.repairs
`

const fromRow = (row: TelemetryBucketRow): TelemetryBucket => ({
  templateId: row.template_id,
  resolution: row.resolution,
  bucketStart: row.bucket_start,
  placed: row.placed,
  correct: row.correct,
  repairs: row.repairs,
})

export class D1SqlStore implements SqlStore {
  constructor(private readonly database: D1Database) {}

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    if (buckets.length === 0) return

    const statement = this.database.prepare(APPEND_BUCKET)
    await this.database.batch(
      buckets.map((bucket) =>
        statement.bind(
          bucket.templateId,
          bucket.resolution,
          bucket.bucketStart,
          bucket.placed,
          bucket.correct,
          bucket.repairs,
        ),
      ),
    )
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    if (query.templateIds.length === 0) return []

    const placeholders = query.templateIds.map(() => '?').join(', ')
    const statement = this.database.prepare(`
      SELECT template_id, resolution, bucket_start, placed, correct, repairs
      FROM telemetry_buckets
      WHERE resolution = ?
        AND bucket_start >= ?
        AND bucket_start < ?
        AND template_id IN (${placeholders})
      ORDER BY template_id, bucket_start
    `)
    const result = await statement
      .bind(query.resolution, query.fromSeconds, query.toSeconds, ...query.templateIds)
      .all<TelemetryBucketRow>()

    return result.results.map(fromRow)
  }
}
