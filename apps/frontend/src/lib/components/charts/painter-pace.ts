import type { PainterHistoryBucket, PainterHistoryResponse, WplaceUserId } from '@caelestis/shared'

export const PAINTER_METRICS = [
  { key: 'placed', label: 'placed', noun: 'placed pixels' },
  { key: 'correct', label: 'correct', noun: 'correct pixels' },
  { key: 'repairs', label: 'repairs', noun: 'repaired pixels' },
] as const

export type PainterMetric = (typeof PAINTER_METRICS)[number]['key']

/** How many leading painters a fresh chart draws before anyone touches the picker. */
export const DEFAULT_VISIBLE_PAINTERS = 5

/** A painter the picker can offer: identity plus what they did over the fetched range. */
export interface PainterOption {
  readonly wplaceUserId: WplaceUserId
  readonly displayName: string
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * Every painter the served buckets mention, summed over the range and ordered like the
 * leaderboard: correct, then placed, then id. Only reported painters exist here; contribution
 * sharing is decided upstream and nothing is reconstructed for anyone the server left out.
 */
export const painterOptions = (buckets: readonly PainterHistoryBucket[]): PainterOption[] => {
  const totals = new Map<
    WplaceUserId,
    { displayName: string; placed: number; correct: number; repairs: number }
  >()
  for (const bucket of buckets) {
    const held = totals.get(bucket.wplaceUserId) ?? {
      displayName: bucket.displayName,
      placed: 0,
      correct: 0,
      repairs: 0,
    }
    held.placed += bucket.placed
    held.correct += bucket.correct
    held.repairs += bucket.repairs
    if (bucket.displayName !== '') held.displayName = bucket.displayName
    totals.set(bucket.wplaceUserId, held)
  }
  return [...totals]
    .map(([wplaceUserId, held]) => ({ wplaceUserId, ...held }))
    .sort((a, b) => b.correct - a.correct || b.placed - a.placed || a.wplaceUserId - b.wplaceUserId)
}

/** The leading painters that a chart shows until the picker says otherwise. */
export const defaultVisiblePainters = (
  options: readonly PainterOption[],
  limit = DEFAULT_VISIBLE_PAINTERS,
): Set<WplaceUserId> => new Set(options.slice(0, limit).map((painter) => painter.wplaceUserId))

/** The label the chart, picker, and tooltip all use for a painter. */
export const painterLabel = (
  painter: Pick<PainterOption, 'wplaceUserId' | 'displayName'>,
): string => painter.displayName || `user ${painter.wplaceUserId}`

/**
 * A hue that depends on nothing but the painter's id, so the same painter keeps the same colour
 * across ranges, metrics, scopes, and reloads. Golden-angle steps keep neighbouring ids apart.
 */
export const painterHue = (wplaceUserId: WplaceUserId): number => {
  const hashed = (Math.imul(wplaceUserId | 0, 0x9e3779b1) >>> 0) % 360
  return Math.round(((hashed * 137.508) % 360) * 10) / 10
}

/** The stroke colour for a painter, with the theme choosing a legible lightness and chroma. */
export const painterColour = (wplaceUserId: WplaceUserId): string =>
  `oklch(var(--painter-l) var(--painter-c) ${painterHue(wplaceUserId)})`

/**
 * A subsequence match score, or null when `query` is not a subsequence of `text`. Higher is
 * better: starts of words and runs of consecutive characters score most, gaps cost a little, and
 * an exact prefix wins outright. Case-insensitive, no dependency, good enough for a name list.
 */
export const fuzzyScore = (query: string, text: string): number | null => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  const haystack = text.toLowerCase()
  if (haystack.startsWith(needle)) return 1_000 + needle.length * 10 - haystack.length
  let score = 0
  let position = 0
  let previous = -2
  for (const character of needle) {
    const index = haystack.indexOf(character, position)
    if (index < 0) return null
    const wordStart = index === 0 || /[\s_\-./]/.test(haystack[index - 1] ?? '')
    score += wordStart ? 10 : 1
    if (index === previous + 1) score += 5
    score -= Math.min(5, index - position)
    previous = index
    position = index + 1
  }
  return score - haystack.length / 100
}

/** The painters matching `query`, best match first; an empty query keeps leaderboard order. */
export const rankPainters = (options: readonly PainterOption[], query: string): PainterOption[] => {
  if (query.trim() === '') return [...options]
  return options
    .flatMap((painter) => {
      const score = Math.max(
        fuzzyScore(query, painterLabel(painter)) ?? Number.NEGATIVE_INFINITY,
        fuzzyScore(query, String(painter.wplaceUserId)) ?? Number.NEGATIVE_INFINITY,
      )
      return score === Number.NEGATIVE_INFINITY ? [] : [{ painter, score }]
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.painter)
}

/** Only the buckets the drawn painters need, so a crowded scope costs what it draws. */
export const bucketsForPainters = (
  history: PainterHistoryResponse,
  painters: ReadonlySet<WplaceUserId>,
): PainterHistoryBucket[] => history.buckets.filter((bucket) => painters.has(bucket.wplaceUserId))
