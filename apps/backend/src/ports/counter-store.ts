/**
 * Live contribution counters. Durable Object today, a counters table later.
 *
 * The contract is **exactness**, not a storage mechanism: a value read back immediately after a
 * record reflects that record. A Durable Object delivers that through single-threaded execution;
 * Postgres delivers the same thing through row-level atomicity. Neither is more exact than the
 * other, so nothing degrades when this is ported.
 *
 * Flushing to the time series is deliberately **not** in this interface. That it happens on a 1m
 * alarm, and that empty buckets are skipped, is an implementation detail of the Cloudflare adapter.
 * Callers only ever promise to record and to read.
 */

export interface CounterDelta {
  readonly templateId: string
  /** Pixels painted, whether or not they matched the template. */
  readonly placed: number
  /** Of those, pixels that matched the template's colour at that coordinate. */
  readonly correct: number
  /** Of the correct ones, pixels that were wrong before this paint — cleanup, not fresh fill. */
  readonly repairs: number
}

/**
 * Counters accumulated **since the last flush** — not lifetime totals.
 *
 * This distinction is easy to get wrong and expensive when you do. The store is a buffer in front of
 * the time series, so it only ever knows about activity the time series has not absorbed yet.
 *
 * ```
 * live total = time-series history (SqlStore) + pending (CounterStore)
 * ```
 */
export interface PendingCounters extends CounterDelta {
  /** When this shard last folded a bucket into the time series, or null if it never has. */
  readonly flushedAt: number | null
}

export interface CounterStore {
  record(deltas: readonly CounterDelta[]): Promise<void>

  /**
   * Unflushed counters for these templates, reflecting anything recorded up to this moment.
   * Returns one entry per requested id, zeroed where there has been no activity.
   */
  readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]>
}
