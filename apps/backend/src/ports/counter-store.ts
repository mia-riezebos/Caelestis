import { type Millis, type Seconds, seconds } from '@wts/shared'

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

export const RESOLUTION_SECONDS: Seconds = seconds(60)
export const GRACE_SECONDS: Seconds = seconds(30)
export const RETENTION_SECONDS: Seconds = seconds(3_600)

/**
 * Derived windows, exported so every implementation and the validator share one definition.
 *
 * These were previously recomputed in three places and agreed only by coincidence. If the validator's
 * notion of "expired" drifts from the store's by even a second, it accepts a bucket whose retained
 * row has already been pruned — and the promotion join then writes only the late portion, which D1's
 * replace semantics turn into a silent undercount. Derive, never restate.
 */
export const FLUSHABLE_AFTER_SECONDS: Seconds = seconds(RESOLUTION_SECONDS + GRACE_SECONDS)
export const EXPIRES_AFTER_SECONDS: Seconds = seconds(FLUSHABLE_AFTER_SECONDS + RETENTION_SECONDS)

/** Per-delta guardrail; a full Wplace charge drain is only around 10,000 pixels. */
export const MAX_COUNTER_DELTA_VALUE = 100_000

/** Prevent unbounded identifiers from creating permanent rows in the shared stores. */
export const MAX_TEMPLATE_ID_LENGTH = 64

/** Bound synchronous validation and writes on the single global counter shard. */
export const MAX_COUNTER_DELTAS_PER_RECORD = 1_000

/** D1's free plan allows 50 queries per invocation; leave headroom for transaction overhead. */
export const FLUSH_BATCH_LIMIT = 40

export interface CounterDelta {
  /** Non-empty template identifier. */
  readonly templateId: string
  /**
   * Safe-integer Unix seconds when the paint happened. This must be the true event time, not the
   * time the caller happened to report it. At record time it must be no later than
   * `now + GRACE_SECONDS`. Before its minute bucket expires, matching local pending, flush-batch,
   * or retained state may absorb a cumulative rewrite. The exact expiry instant is exclusive.
   */
  readonly occurredAt: Seconds
  /** Non-negative integer no greater than MAX_COUNTER_DELTA_VALUE. */
  readonly placed: number
  /** Non-negative integer no greater than placed. */
  readonly correct: number
  /** Non-negative integer no greater than correct. */
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
  readonly flushedAt: Millis | null
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

  /**
   * Consecutive failed flushes to the time series, or 0 when the last flush succeeded.
   *
   * This exists because the flush path deliberately does not throw — see the note in
   * `TelemetryShard.alarm()`. A throwing alarm registers as a platform error that is retained and
   * alertable; returning normally reports success while flushing nothing. This counter is what
   * replaces that signal, so it must be readable rather than merely written.
   */
  readFlushFailureCount(): Promise<number>
}
