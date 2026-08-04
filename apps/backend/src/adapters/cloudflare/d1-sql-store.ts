import { seconds } from '@wts/shared'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { telemetryBuckets } from '../../db/schema.js'
import type { BucketQuery, SqlStore, TelemetryBucket } from '../../ports/index.js'

/**
 * D1 accepts at most 100 bound parameters per query, which is ten times tighter than the SQLite
 * default `TelemetryShard.readPending` chunks against. Reading history for a group of 98 templates
 * — well inside a single node, let alone MAX_MANIFEST_TEMPLATES — otherwise builds one statement
 * D1 rejects outright.
 *
 * 90 leaves room for the three non-id bindings in the WHERE clause and a little slack, so the
 * bound is not sitting exactly on the platform limit.
 *
 * The test fake is `node:sqlite`, whose limit is 32_766, so no test can observe the real ceiling —
 * `readBuckets issues one statement per parameter chunk` counts statements instead.
 */
const READ_BUCKETS_CHUNK_SIZE = 90

/**
 * Template ids one `readBuckets` call may ask for.
 *
 * Chunking fixed the 100-bound-parameter limit and walked into the next one: D1 allows 50 queries
 * per Worker invocation on the free plan and 1,000 on paid, so at 90 ids per query a group of 4,501
 * templates exceeded the free budget and failed the whole read with a D1_ERROR. The wire permits far
 * more than that in one group.
 *
 * 40 chunks leaves headroom under the free budget for whatever else an invocation does. Reading a
 * group larger than this needs paging, which belongs to the route layer that does not exist yet —
 * so this fails immediately, naming the limit, rather than reaching D1 and failing there.
 */
const MAX_READ_BUCKETS_TEMPLATE_IDS = READ_BUCKETS_CHUNK_SIZE * 40

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

    // Deduplicate before chunking. Each chunk returns its own rows and the merge does not join
    // them, so an id repeated across two chunks came back twice and any consumer summing the result
    // double-counted that template's history. It also keeps the query count honest.
    const templateIds = [...new Set(query.templateIds)]
    if (templateIds.length > MAX_READ_BUCKETS_TEMPLATE_IDS) {
      throw new Error(
        `readBuckets accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${templateIds.length}`,
      )
    }
    const rows = []
    for (let offset = 0; offset < templateIds.length; offset += READ_BUCKETS_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_BUCKETS_CHUNK_SIZE)
      rows.push(
        ...(await this.database
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
          .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS))),
      )
    }

    // Each chunk is ordered, but the concatenation of ordered chunks is not: template ids are
    // distributed across chunks in input order, not sort order. The contract is a single ordered
    // result, so the merge has to re-sort.
    return rows
      .map(fromRow)
      .sort(
        (left, right) =>
          left.templateId.localeCompare(right.templateId) || left.bucketStart - right.bucketStart,
      )
  }
}
