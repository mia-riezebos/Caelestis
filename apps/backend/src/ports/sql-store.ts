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
  readonly bucketStart: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

export interface BucketQuery {
  readonly templateIds: readonly string[]
  readonly resolution: number
  readonly fromSeconds: number
  readonly toSeconds: number
}

export interface SqlStore {
  /**
   * Append folded buckets.
   *
   * Idempotent on `(templateId, resolution, bucketStart)` — a retried flush must not double-count,
   * and the DO alarm is exactly the kind of thing that retries.
   */
  appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void>

  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>
}
