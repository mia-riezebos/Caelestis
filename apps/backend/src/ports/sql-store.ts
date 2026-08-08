import type { Seconds } from '@wts/shared'

/**
 * Relational storage. D1 today, Postgres later.
 *
 * D1 is the **system of record**: every tier of the decay ladder lands here, along with current
 * status. The counter store in front of it is a write-absorption buffer, not a second source of
 * truth.
 *
 * No generic `query(sql)` escape hatch. One would make every caller a dialect dependency and quietly
 * undo the portability this interface exists for.
 */

/** One folded bucket of the decay ladder. */
export interface TelemetryBucket {
  readonly templateId: string
  /** Bucket width in seconds — 60, 300, 900, 3600, 21600. */
  readonly resolution: number
  /** Unix seconds, floored to `resolution`. */
  readonly bucketStart: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * Distinct template ids one `readBuckets` call may ask for.
 *
 * D1's budget is where the number comes from. Chunking its reads fixed the 100-bound-parameter
 * limit and walked into the next one: 50 queries per Worker invocation on the free plan, so at 90
 * ids per query a group of 4,501 templates failed the whole read with a D1_ERROR. 40 of those
 * chunks leaves headroom for whatever else an invocation does. The wire permits far more than that
 * in one group, so reading one needs paging — which belongs to the route layer that does not exist
 * yet, and until it does every adapter fails immediately, naming the limit.
 *
 * The bound lives on the port rather than in the D1 adapter because the memory store is the oracle
 * the differential tests measure against: a limit only one adapter enforces is a limit the oracle
 * says does not exist, and a caller written against it meets the real one in production.
 */
export const MAX_READ_BUCKETS_TEMPLATE_IDS = 90 * 40

export const tooManyTemplateIds = (count: number): Error =>
  new Error(
    `readBuckets accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${count}`,
  )

export interface BucketQuery {
  readonly templateIds: readonly string[]
  readonly resolution: number
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

export interface SqlStore {
  /**
   * Write full folded bucket totals with replace semantics.
   *
   * Idempotent on `(templateId, resolution, bucketStart)` — a retried flush must not double-count.
   * A retained bucket may be rewritten after a late arrival, but the value is always its new
   * cumulative total, never an increment.
   */
  appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void>

  /**
   * Read folded buckets for a set of templates at one resolution over a half-open range.
   *
   * Rejects more than `MAX_READ_BUCKETS_TEMPLATE_IDS` distinct ids. Duplicate ids are read once.
   */
  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>
}
