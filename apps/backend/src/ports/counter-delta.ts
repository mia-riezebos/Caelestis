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
 * At the exact retention boundary, an adapter may accept a bucket only while it still has local
 * state that can absorb a cumulative rewrite. Adapters must not let traces extend that boundary.
 */
export const isValidCounterDelta = (
  delta: unknown,
  nowSeconds: number,
  hasLocalTrace: (templateId: string, bucketStart: number) => boolean = () => false,
): delta is CounterDelta => {
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

  const occurredAt = candidate.occurredAt as number
  const bucketStart = Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS
  // Derived from the store's own window, never restated — see EXPIRES_AFTER_SECONDS.
  const bucketExpiresAt = bucketStart + EXPIRES_AFTER_SECONDS
  const latestAccepted = nowSeconds + EVENT_TIME_SKEW_SECONDS
  return (
    occurredAt <= latestAccepted &&
    (bucketExpiresAt > nowSeconds || hasLocalTrace(candidate.templateId, bucketStart))
  )
}
