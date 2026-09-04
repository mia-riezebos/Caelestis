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

/** A bucket-start timestamp paired with cumulative placements through that bucket. */
export interface PacePoint {
  readonly t: number
  readonly cumPlaced: number
}

/** A trailing placement rate stamped at the end of its complete window. */
export interface PaceRatePoint {
  readonly t: number
  readonly v: number
}

/** Calculate trailing px/h windows at the end of each complete source bucket. */
export const rollingPaceSeries = (
  source: readonly PacePoint[],
  bucketSeconds: number,
  windowSeconds: number,
): PaceRatePoint[] => {
  const series: PaceRatePoint[] = []
  const steps = Math.round(windowSeconds / bucketSeconds)
  for (let i = steps - 1; i < source.length; i++) {
    const current = source[i]
    if (current === undefined) continue
    const before = i === steps - 1 ? 0 : source[i - steps]?.cumPlaced
    if (before === undefined) continue
    series.push({
      t: current.t + bucketSeconds,
      v: ((current.cumPlaced - before) / windowSeconds) * 3_600,
    })
  }
  return series
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

const TIME_TICK_STEPS = [
  3_600,
  4 * 3_600,
  6 * 3_600,
  12 * 3_600,
  86_400,
  2 * 86_400,
  7 * 86_400,
  14 * 86_400,
  30 * 86_400,
  90 * 86_400,
  180 * 86_400,
  365 * 86_400,
] as const

/** Pick a readable fixed time step for the available horizontal space. */
export const timeTickStep = (span: number, plotWidth: number): number => {
  const targetTicks = Math.max(2, Math.floor(plotWidth / 72))
  const minimumStep = span / targetTicks
  const listed = TIME_TICK_STEPS.find((step) => step >= minimumStep)
  if (listed !== undefined) return listed
  const year = TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1]
  return Math.ceil(minimumStep / year) * year
}

// ── Axis and window helpers ────────────────────────────────────────────────────────────────────

export interface AxisScale {
  /** The top of the axis: the smallest tick multiple that contains every value. */
  readonly max: number
  /** Evenly spaced tick values from one step up to `max`. */
  readonly ticks: readonly number[]
}

/**
 * A value axis whose gridlines are 1, 2 or 5 times a power of ten, chosen so four to six of them
 * fit under the data. The top of the axis is the data plus a little headroom, not the next round
 * number: rounding 33k up to 40k left a fifth of the plot empty.
 */
export const axisScale = (maxValue: number, targetTicks = 4, minimumStep = 0): AxisScale => {
  if (!(maxValue > 0)) {
    const step = Math.max(1, minimumStep)
    return { max: step, ticks: [step] }
  }
  const rough = maxValue / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const candidates = [1, 2, 5, 10, 20, 50].map((factor) => factor * magnitude)
  let index = Math.max(
    0,
    candidates.findLastIndex((candidate) => candidate <= rough),
  )
  const count = (step: number): number => Math.floor(maxValue / step + 1e-9)
  while (
    count(Math.max(minimumStep, candidates[index] ?? rough)) > 6 &&
    index < candidates.length - 1
  ) {
    index++
  }
  const step = Math.max(minimumStep, candidates[index] ?? rough)
  const ticks: number[] = []
  for (let i = 1; i <= count(step); i++) ticks.push(Number((i * step).toPrecision(12)))
  if (ticks.length === 0) ticks.push(step)
  const max = Math.max(ticks[ticks.length - 1] ?? step, Number((maxValue * 1.04).toPrecision(12)))
  return { max, ticks }
}

/** Compact axis and tooltip numbers: 850, 2.4k, 12k, and 0.25 for slow paces. */
export const formatCount = (value: number): string => {
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, {
      maximumFractionDigits: value >= 10_000 ? 0 : 1,
    })}k`
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 })
}

/**
 * The points inside `[from, to]`, plus one interpolated point on each edge, so a windowed series
 * still touches both sides of the plot instead of starting at the first bucket inside the window.
 */
export const clipSeries = <T extends { readonly t: number }>(
  series: readonly T[],
  from: number,
  to: number,
  lerp: (a: T, b: T, fraction: number) => T,
): T[] => {
  const clipped: T[] = []
  for (let i = 0; i < series.length; i++) {
    const point = series[i]
    if (point === undefined) continue
    if (point.t < from) {
      const next = series[i + 1]
      if (next !== undefined && next.t > from) {
        clipped.push(lerp(point, next, (from - point.t) / (next.t - point.t)))
      }
      continue
    }
    if (point.t > to) {
      const previous = series[i - 1]
      if (previous !== undefined && previous.t < to) {
        clipped.push(lerp(previous, point, (to - previous.t) / (point.t - previous.t)))
      }
      break
    }
    clipped.push(point)
  }
  return clipped
}

/** The nearest entry of a sorted list, or null when the list is empty. */
export const nearestSorted = (sorted: readonly number[], target: number): number | null => {
  if (sorted.length === 0) return null
  let low = 0
  let high = sorted.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] ?? 0) < target) low = middle + 1
    else high = middle
  }
  const candidate = sorted[low] ?? 0
  const before = sorted[low - 1]
  return before !== undefined && target - before <= candidate - target ? before : candidate
}

/** Round a time to the nearest bucket boundary and keep it inside the fetched range. */
export const snapTime = (t: number, resolution: number, from: number, to: number): number =>
  Math.min(to, Math.max(from, Math.round(t / resolution) * resolution))

export interface TimeWindow {
  readonly from: number
  readonly to: number
}

/**
 * Keep a window inside `[from, to]` and at least `minimum` wide. A window that is too narrow grows
 * around its centre; one that pokes outside the range slides back in without changing its width.
 */
export const clampWindow = (
  window: TimeWindow,
  from: number,
  to: number,
  minimum: number,
): TimeWindow => {
  const span = Math.min(to - from, Math.max(minimum, window.to - window.from))
  let start = window.from
  if (window.to - window.from < span) start = (window.from + window.to) / 2 - span / 2
  start = Math.min(to - span, Math.max(from, start))
  return { from: start, to: start + span }
}

export const RANGE_PRESETS = [
  { key: '6h', seconds: 6 * 3_600, label: 'the last 6 hours' },
  { key: '1d', seconds: 86_400, label: 'the last day' },
  { key: '3d', seconds: 3 * 86_400, label: 'the last 3 days' },
  { key: '7d', seconds: 7 * 86_400, label: 'the last 7 days' },
  { key: '30d', seconds: 30 * 86_400, label: 'the last 30 days' },
] as const

export type RangePreset = (typeof RANGE_PRESETS)[number]

/** Only presets that are narrower than the whole history and wide enough to show detail. */
export const availableRangePresets = (span: number, minimum: number): RangePreset[] =>
  RANGE_PRESETS.filter((preset) => preset.seconds < span && preset.seconds >= minimum)

/** One arrow-key nudge: about a hundredth of the history, never finer than a bucket. */
export const windowKeyStep = (span: number, resolution: number): number =>
  Math.max(resolution, Math.ceil(span / 100 / resolution) * resolution)
