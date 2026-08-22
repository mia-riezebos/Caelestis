import { type Seconds, seconds } from '@caelestis/shared'
import {
  type CounterDelta,
  EXPIRES_AFTER_SECONDS,
  GRACE_SECONDS,
  MAX_COUNTER_DELTA_VALUE,
  MAX_TEMPLATE_ID_LENGTH,
  RESOLUTION_SECONDS,
} from './counter-store.js'

/** Ordinary client clock skew allowed on either edge of the accepted event-time window. */
export const EVENT_TIME_SKEW_SECONDS = GRACE_SECONDS

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

const isBoundedCounter = (value: unknown): value is number =>
  isNonNegativeSafeInteger(value) && value <= MAX_COUNTER_DELTA_VALUE

/**
 * Runtime validation for the CounterStore wire contract.
 *
 * The future bound matters because a future bucket cannot become flushable until wall time catches
 * up with it. Without that bound, pending rows could remain live and consume storage indefinitely.
 *
 * **Expiry alone decides how late is too late.** This used to take a `hasLocalTrace` callback, on
 * the rule that an old bucket could still be accepted while local state existed to absorb a
 * cumulative rewrite — but the callback was only ever consulted once the bucket had expired, and
 * both implementations opened by returning false on exactly that condition. The disjunct was
 * unconditionally false and the SQL behind it was dead. Rather than leave a contract documented but
 * unimplemented, the rule is now what the code does.
 *
 * What that gives up: if D1 already holds a bucket while the shard has no retained row for it, a
 * late rewrite promotes only the late portion, and appendBuckets replaces rather than adds. Within
 * the acceptance window a retained row exists whenever the shard flushed the bucket, so reaching
 * this needs the Durable Object's storage to have been lost — which is not a mode Durable Objects
 * have. Accepting up to RETENTION_SECONDS of client lag is worth more than guarding it.
 *
 * The exact expiry instant is exclusive.
 */
export const isValidCounterDelta = (delta: unknown, nowSeconds: Seconds): delta is CounterDelta => {
  if (typeof delta !== 'object' || delta === null) return false

  const candidate = delta as Partial<Record<keyof CounterDelta, unknown>>
  if (
    typeof candidate.templateId !== 'string' ||
    candidate.templateId.length === 0 ||
    candidate.templateId.length > MAX_TEMPLATE_ID_LENGTH
  ) {
    return false
  }
  if (!isBoundedCounter(candidate.placed)) return false
  if (!isBoundedCounter(candidate.correct)) return false
  if (!isBoundedCounter(candidate.repairs)) return false
  if (candidate.repairs > candidate.correct || candidate.correct > candidate.placed) return false
  if (!Number.isSafeInteger(candidate.occurredAt)) return false

  const occurredAt = seconds(candidate.occurredAt as number)
  const bucketStart = seconds(Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS)
  // Derived from the store's own window, never restated — see EXPIRES_AFTER_SECONDS.
  const bucketExpiresAt = bucketStart + EXPIRES_AFTER_SECONDS
  const latestAccepted = nowSeconds + EVENT_TIME_SKEW_SECONDS
  return occurredAt <= latestAccepted && bucketExpiresAt > nowSeconds
}
