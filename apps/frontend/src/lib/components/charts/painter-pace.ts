import type { PainterTotal, WplaceUserId } from '@caelestis/shared'

/** How many leading painters a fresh chart draws before anyone touches the picker. */
export const DEFAULT_VISIBLE_PAINTERS = 5

/** How many painters the panel asks the server to list; the route clamps to the same. */
export const MAX_PAINTER_OPTIONS = 500

/** How many painters may be drawn at once: the history route's `painters=` bound. */
export const MAX_SELECTED_PAINTERS = 50

/**
 * The next override map after toggling one painter, refusing to grow the selection past `max`
 * because `/painter-history` would refuse the request and every line would vanish with it.
 */
export const togglePainterSelection = (
  overrides: Readonly<Record<number, boolean>>,
  selected: ReadonlySet<number>,
  wplaceUserId: number,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> => {
  const shown = selected.has(wplaceUserId)
  if (!shown && selected.size >= max) return overrides
  return { ...overrides, [wplaceUserId]: !shown }
}

/** A painter the picker can offer: `GET /telemetry/painters` already sums and orders them. */
export type PainterOption = PainterTotal

/** Set the entire picker selection in one update, within the history request limit. */
export const selectAllPainters = (
  options: readonly PainterOption[],
  shown: boolean,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> =>
  Object.fromEntries(options.map((painter, index) => [painter.wplaceUserId, shown && index < max]))

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
