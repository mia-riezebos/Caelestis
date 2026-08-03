/**
 * Live contribution counters. Durable Object today, a counters table later.
 *
 * The contract is **exactness**, not a storage mechanism: a value read back immediately after a
 * record reflects that record. A Durable Object delivers that through single-threaded execution;
 * Postgres delivers the same thing through row-level atomicity. Neither is more exact than the
 * other, so nothing degrades when this is ported.
 *
 * Flushing to the time series is deliberately **not** in this interface. The bucket resolution,
 * grace period, and retention window are contract values because every implementation must assign
 * and retain activity identically; alarms remain an adapter detail.
 */

export const RESOLUTION_SECONDS = 60
export const GRACE_SECONDS = 30
export const RETENTION_SECONDS = 3_600

export interface CounterDelta {
  /** Non-empty template identifier. */
  readonly templateId: string
  /**
   * Safe-integer Unix seconds when the paint happened. This must be the true event time, not the
   * time the caller happened to report it. At record time it must be no later than
   * `now + GRACE_SECONDS`. Its minute bucket must not have expired unless the store still has a
   * local pending, flush-batch, or retained row that can absorb a cumulative rewrite.
   */
  readonly occurredAt: number
  /** Non-negative safe integer: pixels painted, whether or not they matched the template. */
  readonly placed: number
  /** Non-negative safe integer: pixels that matched the template's colour at that coordinate. */
  readonly correct: number
  /** Non-negative safe integer: correct pixels that were cleanup rather than fresh fill. */
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
export interface PendingCounters {
  readonly templateId: string
  readonly placed: number
  readonly correct: number
  readonly repairs: number
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

  /** Number of deltas rejected as invalid or expired without any matching local bucket state. */
  readDroppedLateCount(): Promise<number>
}
