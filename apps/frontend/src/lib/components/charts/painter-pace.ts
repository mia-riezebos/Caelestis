import type { ContributionDay, WplaceUserId } from '@caelestis/shared'

export const DAY_SECONDS = 86_400

export const PAINTER_METRICS = [
  { key: 'placed', label: 'placed', noun: 'placed pixels' },
  { key: 'correct', label: 'correct', noun: 'correct pixels' },
  { key: 'repairs', label: 'repairs', noun: 'repaired pixels' },
] as const

export type PainterMetric = (typeof PAINTER_METRICS)[number]['key']

/** How many leading painters a fresh chart draws before anyone touches the legend. */
export const DEFAULT_VISIBLE_PAINTERS = 8

export interface PainterDay {
  /** UTC midnight, Unix seconds. */
  readonly day: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

export interface PainterTotals {
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

export interface PainterSeries {
  readonly wplaceUserId: WplaceUserId
  readonly displayName: string
  /** Only the days the server served, keyed by UTC midnight. `dailyPoints` fills the rest. */
  readonly byDay: ReadonlyMap<number, PainterDay>
  readonly totals: PainterTotals
}

/** The UTC midnight at or before `t`. */
export const dayStart = (t: number): number => Math.floor(t / DAY_SECONDS) * DAY_SECONDS

/** The first UTC midnight at or after `t`: the first whole day a `day >= t` query returns. */
export const nextDayStart = (t: number): number => Math.ceil(t / DAY_SECONDS) * DAY_SECONDS

/** Every UTC day start from the one containing `from` through the one containing `to - 1`. */
export const dayTimes = (from: number, to: number): number[] => {
  const first = dayStart(from)
  const last = dayStart(Math.max(first, to - 1))
  const times: number[] = []
  for (let t = first; t <= last; t += DAY_SECONDS) times.push(t)
  return times
}

/**
 * One sparse daily series per painter for `[from, to)`, summed across templates.
 *
 * The rows are the server's already reduced painter-days, so summing them across templates is
 * safe. Only painters with at least one served row inside the range get a series: contribution
 * sharing is decided upstream, and a painter the server left out is not reconstructed from
 * anything else. Days stay sparse here because a canvas scope can hold thousands of painters of
 * whom only a handful are drawn; `dailyPoints` zero-fills a painter on demand.
 *
 * Series come back in leaderboard order: correct, then placed, then id, so the first entries are
 * the leading painters.
 */
export const painterSeries = (
  rows: readonly ContributionDay[],
  from: number,
  to: number,
): PainterSeries[] => {
  const first = dayStart(from)
  const last = dayStart(Math.max(first, to - 1))
  interface Draft {
    wplaceUserId: WplaceUserId
    displayName: string
    nameDay: number
    byDay: Map<number, { day: number; placed: number; correct: number; repairs: number }>
    totals: { placed: number; correct: number; repairs: number }
  }
  const drafts = new Map<WplaceUserId, Draft>()
  for (const row of rows) {
    if (row.day < first || row.day > last) continue
    let draft = drafts.get(row.wplaceUserId)
    if (draft === undefined) {
      draft = {
        wplaceUserId: row.wplaceUserId,
        displayName: '',
        nameDay: -1,
        byDay: new Map(),
        totals: { placed: 0, correct: 0, repairs: 0 },
      }
      drafts.set(row.wplaceUserId, draft)
    }
    // The newest row carries the freshest label for a painter who renamed.
    if (row.day >= draft.nameDay && row.displayName !== '') {
      draft.displayName = row.displayName
      draft.nameDay = row.day
    }
    const entry = draft.byDay.get(row.day) ?? { day: row.day, placed: 0, correct: 0, repairs: 0 }
    entry.placed += row.placed
    entry.correct += row.correct
    entry.repairs += row.repairs
    draft.byDay.set(row.day, entry)
    draft.totals.placed += row.placed
    draft.totals.correct += row.correct
    draft.totals.repairs += row.repairs
  }
  const series: PainterSeries[] = [...drafts.values()].map((draft) => ({
    wplaceUserId: draft.wplaceUserId,
    displayName: draft.displayName,
    byDay: draft.byDay,
    totals: draft.totals,
  }))
  series.sort(
    (a, b) =>
      b.totals.correct - a.totals.correct ||
      b.totals.placed - a.totals.placed ||
      a.wplaceUserId - b.wplaceUserId,
  )
  return series
}

/** A painter's day for every UTC day of `[from, to)`, zero where the server served no row. */
export const dailyPoints = (painter: PainterSeries, from: number, to: number): PainterDay[] =>
  dayTimes(from, to).map(
    (day) => painter.byDay.get(day) ?? { day, placed: 0, correct: 0, repairs: 0 },
  )

/** The leading painters that a chart shows until the legend says otherwise. */
export const defaultVisiblePainters = (
  series: readonly PainterSeries[],
  limit = DEFAULT_VISIBLE_PAINTERS,
): Set<WplaceUserId> => new Set(series.slice(0, limit).map((painter) => painter.wplaceUserId))

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

/** The label the chart, legend, and tooltip all use for a painter. */
export const painterLabel = (painter: PainterSeries): string =>
  painter.displayName || `user ${painter.wplaceUserId}`
