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
