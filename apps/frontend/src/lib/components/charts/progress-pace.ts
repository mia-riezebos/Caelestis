import type { HistoryResponse } from '@caelestis/shared'

export const PACE_WINDOWS = [
  { key: '30m', seconds: 1_800 },
  { key: '1h', seconds: 3_600 },
  { key: '2h', seconds: 7_200 },
  { key: '3h', seconds: 10_800 },
  { key: '6h', seconds: 21_600 },
  { key: '12h', seconds: 43_200 },
  { key: '1d', seconds: 86_400 },
] as const

export type PaceWindowKey = (typeof PACE_WINDOWS)[number]['key']

/** The oldest server-selected retained tier that can represent one rolling window. */
export interface PaceHistorySource {
  readonly window: PaceWindowKey
  readonly history: HistoryResponse
}

export interface PaceAverage {
  readonly placed: number
  readonly correct: number
  readonly hours: number
}

/** Average only complete retained buckets inside the requested window. */
export const averagePace = (
  history: HistoryResponse,
  to: number,
  windowSeconds: number,
): PaceAverage | null => {
  const { coverageStart, resolution } = history
  if (coverageStart === undefined || resolution === undefined) return null

  const from = Math.ceil(Math.max(to - windowSeconds, coverageStart) / resolution) * resolution
  const until = Math.floor(to / resolution) * resolution
  if (until <= from) return null

  let placed = 0
  let correct = 0
  for (const bucket of history.buckets) {
    if (bucket.bucketStart < from || bucket.bucketStart >= until) continue
    placed += bucket.placed
    correct += bucket.correct
  }
  const hours = (until - from) / 3_600
  return { placed: placed / hours, correct: correct / hours, hours }
}
