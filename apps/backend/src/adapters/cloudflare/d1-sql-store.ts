import { seconds } from '@wts/shared'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { telemetryBuckets } from '../../db/schema.js'
import {
  assertValidBuckets,
  type BucketQuery,
  compareBuckets,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  READ_BUCKETS_CHUNK_SIZE,
  type SqlStore,
  type TelemetryBucket,
  tooManyTemplateIds,
} from '../../ports/index.js'

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
    // Ahead of the batch, so a poison row is a synchronous error naming the column rather than a
    // CHECK failure the shard's alarm retries forever.
    assertValidBuckets(buckets)

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

    // Deduplicate before chunking. Each chunk returns its own rows and the merge does not join
    // them, so an id repeated across two chunks came back twice and any consumer summing the result
    // double-counted that template's history. It also keeps the query count honest.
    const templateIds = [...new Set(query.templateIds)]
    if (templateIds.length > MAX_READ_BUCKETS_TEMPLATE_IDS)
      throw tooManyTemplateIds(templateIds.length)
    // Concatenated rather than spread into `push`. A spread passes every row as a separate argument,
    // so a chunk returning more rows than V8's argument limit — around 125,000, which 90 templates
    // at minute resolution reach in under a day — throws RangeError instead of answering. The id
    // count is bounded; the row count is bounded only by the window the caller asks for.
    let rows: (typeof telemetryBuckets.$inferSelect)[] = []
    for (let offset = 0; offset < templateIds.length; offset += READ_BUCKETS_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)
      rows = rows.concat(
        await this.database
          .select()
          .from(telemetryBuckets)
          .where(
            and(
              eq(telemetryBuckets.resolution, query.resolution),
              gte(telemetryBuckets.bucketStartS, query.fromSeconds),
              lt(telemetryBuckets.bucketStartS, query.toSeconds),
              inArray(telemetryBuckets.templateId, chunk),
            ),
          )
          .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS)),
      )
    }

    // Each chunk is ordered, but the concatenation of ordered chunks is not: template ids are
    // distributed across chunks in input order, not sort order. The contract is a single ordered
    // result, so the merge has to re-sort.
    //
    // The bucketStart tiebreak is redundant today and kept for explicitness: chunking is by template
    // id, so one template's buckets always land in a single chunk already ordered by SQL, and
    // Array.prototype.sort is stable. Dropping it changes no outcome, so no test can pin it — said
    // here rather than left looking load-bearing.
    return rows.map(fromRow).sort(compareBuckets)
  }
}
