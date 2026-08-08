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
 *
 * Derived from the chunk size rather than restating it. Written as a bare `90 * 40` the two numbers
 * drift apart silently: adding one binding to the WHERE clause makes 45 the correct chunk size, and
 * a cap still admitting 3,600 ids then issues 80 queries against the 50-query budget this constant
 * exists to respect — a D1_ERROR on a call the port declares legal and the oracle accepts.
 */
/**
 * Template ids per query. D1 accepts at most 100 bound parameters, ten times tighter than the SQLite
 * default; 90 leaves room for the three non-id bindings in the WHERE clause and a little slack. The
 * test fake is `node:sqlite`, whose limit is 32_766, so no test can observe the real ceiling —
 * `readBuckets issues one statement per parameter chunk` counts statements instead.
 */
export const READ_BUCKETS_CHUNK_SIZE = 90
const READ_BUCKETS_CHUNK_BUDGET = 40
export const MAX_READ_BUCKETS_TEMPLATE_IDS = READ_BUCKETS_CHUNK_SIZE * READ_BUCKETS_CHUNK_BUDGET

export const tooManyTemplateIds = (count: number): Error =>
  new Error(
    `readBuckets accepts at most ${MAX_READ_BUCKETS_TEMPLATE_IDS} template ids per call; received ${count}`,
  )

/** Bucket widths the decay ladder folds to, matching `telemetry_buckets_resolution_check`. */
const LADDER_RESOLUTIONS: readonly number[] = [60, 300, 900, 3_600, 21_600]

/**
 * The domain `telemetry_buckets` will actually store, stated where both adapters can honour it.
 *
 * D1 enforces all of this in SQL and the memory store enforced none of it, so the oracle the
 * differential tests measure against accepted five classes of row D1 rejects — a misaligned or
 * negative `bucketStart`, an off-ladder `resolution`, a fractional counter, and counters out of
 * `repairs <= correct <= placed` order. Same defect the read cap had, on the write path, and the
 * consequence is worse than a surprise in production: `TelemetryShard.alarm` catches the rejection
 * and re-arms without clearing `flush_batch`, so one poison row is re-sent every alarm forever and
 * the shard stops flushing entirely while `readPending` keeps counting the stuck batch.
 *
 * Today's only writer floors to 60 and always sends `resolution: 60`, so nothing currently produces
 * one. The ladder-fold writer that fills tiers 300 through 21600 is exactly where a misfloored start
 * would appear.
 */
export const invalidBucket = (bucket: TelemetryBucket): string | null => {
  const { resolution, bucketStart, placed, correct, repairs } = bucket
  if (!LADDER_RESOLUTIONS.includes(resolution))
    return `resolution ${resolution} is not a ladder tier`
  if (!Number.isSafeInteger(bucketStart) || bucketStart < 0) {
    return `bucketStart ${bucketStart} is not a non-negative integer`
  }
  if (bucketStart % resolution !== 0) {
    return `bucketStart ${bucketStart} is not a multiple of resolution ${resolution}`
  }
  if (![placed, correct, repairs].every(Number.isSafeInteger)) return 'counters must be integers'
  if (!(repairs >= 0 && repairs <= correct && correct <= placed)) {
    return `counters must satisfy 0 <= repairs <= correct <= placed, got ${repairs}, ${correct}, ${placed}`
  }
  return null
}

export const assertValidBuckets = (buckets: readonly TelemetryBucket[]): void => {
  for (const bucket of buckets) {
    const reason = invalidBucket(bucket)
    if (reason !== null) throw new Error(`appendBuckets rejected ${bucket.templateId}: ${reason}`)
  }
}

/**
 * The single order every `readBuckets` implementation returns, so the adapters stay comparable.
 *
 * Compared with `<`/`>` rather than `localeCompare`, which matches SQLite's BINARY collation and is
 * total. `localeCompare` treats default-ignorable codepoints as equal — `'a­b'` ties with
 * `'ab'` — and `Array.prototype.sort` is stable, so a tie falls back to input order: SQL order on
 * D1, `Map` insertion order in memory. Two adapters, one input, different arrays, on ids the
 * boundary permits.
 */
export const compareBuckets = (left: TelemetryBucket, right: TelemetryBucket): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.bucketStart - right.bucketStart
}

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
