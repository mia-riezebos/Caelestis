import { seconds } from '@wts/shared'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { telemetryBuckets } from '../../db/schema.js'
import type { BucketQuery, SqlStore, TelemetryBucket } from '../../ports/index.js'

const fromRow = (row: typeof telemetryBuckets.$inferSelect): TelemetryBucket => ({
  templateId: row.templateId,
  resolution: row.resolution,
  bucketStart: seconds(row.bucketStartS),
  placed: row.placed,
  correct: row.correct,
  repairs: row.repairs,
})

export class D1SqlStore implements SqlStore {
  private readonly database: DrizzleD1Database

  constructor(database: D1Database) {
    this.database = drizzle(database)
  }

  async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    if (buckets.length === 0) return

    const statements = buckets.map((bucket) =>
      this.database
        .insert(telemetryBuckets)
        .values({
          templateId: bucket.templateId,
          resolution: bucket.resolution,
          bucketStartS: bucket.bucketStart,
          placed: bucket.placed,
          correct: bucket.correct,
          repairs: bucket.repairs,
        })
        .onConflictDoUpdate({
          target: [
            telemetryBuckets.templateId,
            telemetryBuckets.resolution,
            telemetryBuckets.bucketStartS,
          ],
          set: {
            placed: sql`excluded.placed`,
            correct: sql`excluded.correct`,
            repairs: sql`excluded.repairs`,
          },
        }),
    )

    await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    if (query.templateIds.length === 0) return []

    const rows = await this.database
      .select()
      .from(telemetryBuckets)
      .where(
        and(
          eq(telemetryBuckets.resolution, query.resolution),
          gte(telemetryBuckets.bucketStartS, query.fromSeconds),
          lt(telemetryBuckets.bucketStartS, query.toSeconds),
          inArray(telemetryBuckets.templateId, [...query.templateIds]),
        ),
      )
      .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS))

    return rows.map(fromRow)
  }
}
