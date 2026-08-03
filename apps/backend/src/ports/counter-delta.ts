import {
  type CounterDelta,
  GRACE_SECONDS,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
} from './counter-store.js'

/** Ordinary client clock skew allowed on either edge of the accepted event-time window. */
export const EVENT_TIME_SKEW_SECONDS = GRACE_SECONDS

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

/**
 * Runtime validation for the CounterStore wire contract.
 *
 * The future bound matters because a future bucket cannot become flushable until wall time catches
 * up with it. Without that bound, pending rows could remain live and consume storage indefinitely.
 */
export const isValidCounterDelta = (delta: unknown, nowSeconds: number): delta is CounterDelta => {
  if (typeof delta !== 'object' || delta === null) return false

  const candidate = delta as Partial<Record<keyof CounterDelta, unknown>>
  if (typeof candidate.templateId !== 'string' || candidate.templateId.length === 0) return false
  if (!isNonNegativeSafeInteger(candidate.placed)) return false
  if (!isNonNegativeSafeInteger(candidate.correct)) return false
  if (!isNonNegativeSafeInteger(candidate.repairs)) return false
  if (!Number.isSafeInteger(candidate.occurredAt)) return false

  const occurredAt = candidate.occurredAt as number
  const earliestAccepted =
    nowSeconds - RETENTION_SECONDS - RESOLUTION_SECONDS - EVENT_TIME_SKEW_SECONDS
  const latestAccepted = nowSeconds + EVENT_TIME_SKEW_SECONDS
  return occurredAt >= earliestAccepted && occurredAt <= latestAccepted
}
