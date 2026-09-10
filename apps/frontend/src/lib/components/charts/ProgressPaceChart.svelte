<script lang="ts">
  import {
    formatCount,
    formatExactCount,
    formatPixels,
    type HistoryBucket,
    type ArchiveProgressSample,
    type ProgressSample,
    type PainterHistoryBucket,
  } from '@caelestis/shared'
  import { untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { Tween } from 'svelte/motion'
  import { fade, type TransitionConfig } from 'svelte/transition'
  import { type Persisted, persisted } from '$lib/persisted.svelte'
  import {
    PAINTER_METRICS,
    type PainterMetric,
    type PainterOption,
    painterColour,
    painterLabel,
  } from '$lib/components/charts/painter-pace'
  import PainterPicker from '$lib/components/charts/PainterPicker.svelte'
  import PacePicker from '$lib/components/charts/PacePicker.svelte'
  import {
    availableRangePresets,
    axisScale,
    clampWindow,
    clipSeries,
    nearestSorted,
    PACE_WINDOWS,
    type PaceHistorySource,
    type PacePoint,
    type PaceRatePoint,
    type PainterHistorySource,
    rollingPaceSeries,
    snapTime,
    timeTickStep,
    type TimeWindow,
    windowKeyStep,
  } from '$lib/components/charts/progress-pace'
  import SlidingTabs from '$lib/components/charts/SlidingTabs.svelte'
  import { archiveIntervals } from '$lib/archive-history'
  import { mergeObservedProgress } from '$lib/progress-history'

  let {
    buckets,
    archiveSamples = [],
    progressSamples = [],
    paceHistories = [],
    resolution,
    from,
    to,
    anchorCorrect,
    anchorMismatched,
    finished = false,
    live = false,
    painters = [],
    selectedPainters = new Set<number>(),
    onTogglePainter = () => {},
    painterHistories = [],
    windows = persisted<string[]>('caelestis:pace-windows', ['1h', '6h']),
  }: {
    buckets: readonly HistoryBucket[]
    archiveSamples?: readonly ArchiveProgressSample[]
    progressSamples?: readonly ProgressSample[]
    /** One server-selected retained source for each rolling window. */
    paceHistories?: readonly PaceHistorySource[]
    /** Who painted in the range, leading first: the picker's list. */
    painters?: readonly PainterOption[]
    /** The painters being drawn; whoever fetches `painterHistories` owns this. */
    selectedPainters?: ReadonlySet<number>
    onTogglePainter?: (wplaceUserId: number) => void
    /** The selected painters' retained sources for the enabled rolling windows. */
    painterHistories?: readonly PainterHistorySource[]
    /** The enabled rolling windows, shared with whoever fetches the painter sources. */
    windows?: Persisted<string[]>
    /** Bucket width in seconds; buckets are summed across templates per bucket start. */
    resolution: number
    from: number
    to: number
    /**
     * Current or frozen canvas counts are drawn only at `to`. Historical levels come exclusively
     * from saved observations; placement reports are not a net canvas-change ledger.
     */
    anchorCorrect: number
    anchorMismatched: number
    /** A finished scope has a frozen final observation, even though it has no live pulse. */
    finished?: boolean
    /** The right edge is now: the canvas is still being painted, so the last point is live. */
    live?: boolean
  } = $props()

  /**
   * Saved observations supply completion areas. Reported placements supply rolling pace on the
   * right axis. Longer pace windows use darker, thicker lines.
   */
  const storedWindows = $derived(windows)
  const enabledWindows = $derived(new Set(storedWindows.value))
  const toggleWindow = (key: string): void => {
    const next = new Set(storedWindows.value)
    if (!next.delete(key)) next.add(key)
    storedWindows.value = [...next]
  }

  /** A rolling window needs at least two samples from whichever retained tier supplies it. */
  const windowUsable = (seconds: number, bucketSeconds: number): boolean =>
    seconds >= 2 * bucketSeconds

  interface Point {
    t: number
    placed: number
    cumPlaced: number
  }

  const points = $derived.by<Point[]>(() => {
    if (buckets.length === 0) return []
    const byStart = new Map<number, number>()
    for (const bucket of buckets) {
      byStart.set(bucket.bucketStart, (byStart.get(bucket.bucketStart) ?? 0) + bucket.placed)
    }
    const filled: Point[] = []
    let cumPlaced = 0
    const reportStart = archiveSamples.length === 0 ? from : Math.max(from, Math.min(...buckets.map((bucket) => bucket.bucketStart)))
    const first = Math.ceil(reportStart / resolution) * resolution
    for (let t = first; t < to; t += resolution) {
      const placed = byStart.get(t) ?? 0
      cumPlaced += placed
      filled.push({
        t,
        placed,
        cumPlaced,
      })
    }
    return filled
  })

  // Painter buckets are written per report while template buckets wait for the counter flush, so
  // the plot also opens when only painters have reported yet.
  const hasActivity = $derived(
    archiveSamples.length > 0 ||
    progressSamples.length > 0 ||
    ((live || finished) && anchorCorrect + anchorMismatched > 0) ||
    points.some((p) => p.placed > 0) ||
      painterHistories.some((source) => source.history.buckets.length > 0),
  )

  // ── Time window ──────────────────────────────────────────────────────────────────────────────
  // `null` shows the whole fetched range. Presets stay attached to a moving live edge, while
  // pointer and keyboard selections keep their absolute timestamps across a re-fetch.
  let selection = $state<TimeWindow | null>(null)
  let relativePreset = $state<number | null>(null)
  const span = $derived(to - from)
  const MIN_SELECTION = $derived(Math.min(span, resolution * 6))
  const view = $derived.by<TimeWindow>(() => {
    if (relativePreset !== null) {
      return clampWindow({ from: to - relativePreset, to }, from, to, MIN_SELECTION)
    }
    return selection === null ? { from, to } : clampWindow(selection, from, to, MIN_SELECTION)
  })
  const zoomed = $derived(view.from > from || view.to < to)
  const resetWindow = (): void => {
    relativePreset = null
    selection = null
  }
  const selectWindow = (window: TimeWindow): void => {
    relativePreset = null
    selection = window
  }
  const selectPreset = (seconds: number): void => {
    relativePreset = seconds
    selection = null
  }

  const presets = $derived(availableRangePresets(span, MIN_SELECTION))
  const presetActive = (seconds: number): boolean => relativePreset === seconds

  const lerpRate = (a: PaceRatePoint, b: PaceRatePoint, fraction: number): PaceRatePoint => ({
    t: a.t + (b.t - a.t) * fraction,
    v: a.v + (b.v - a.v) * fraction,
  })


  const retainedPacePoints = (source: PaceHistorySource): PacePoint[] => {
    const { buckets: paceBuckets, coverageStart, resolution: paceResolution } = source.history
    if (paceResolution === undefined || coverageStart === undefined) return []
    const placedByStart = new Map<number, number>()
    for (const bucket of paceBuckets) {
      placedByStart.set(bucket.bucketStart, (placedByStart.get(bucket.bucketStart) ?? 0) + bucket.placed)
    }
    const firstBucket = Math.ceil(coverageStart / paceResolution) * paceResolution
    const filled: PacePoint[] = []
    let cumPlaced = 0
    for (let t = firstBucket; t + paceResolution <= to; t += paceResolution) {
      cumPlaced += placedByStart.get(t) ?? 0
      filled.push({ t, cumPlaced })
    }
    return filled
  }

  // The full-range series depend only on the data, so dragging the window never recomputes them.
  const paceWindows = $derived(
    PACE_WINDOWS.map((pace) => {
      const retained = paceHistories.find((source) => source.window === pace.key)
      const source = windowUsable(pace.seconds, resolution)
        ? { points: points.filter((point) => point.t + resolution <= to), resolution }
        : retained?.history.resolution !== undefined &&
            windowUsable(pace.seconds, retained.history.resolution)
          ? { points: retainedPacePoints(retained), resolution: retained.history.resolution }
          : null
      const fullSeries =
        source === null ? [] : rollingPaceSeries(source.points, source.resolution, pace.seconds)
      return { ...pace, usable: fullSeries.length > 0, fullSeries }
    }),
  )

  // Everyone's rolling pace lines are one more entry in the pace picker, pinned at the top, so a
  // reader can leave painters alone on the axis or bring the whole template back.
  const storedAllUsers = persisted<boolean>('caelestis:pace-all-users', true)
  const allUsersShown = $derived(storedAllUsers.value !== false)
  const enabledPaces = $derived(
    allUsersShown
      ? paceWindows.filter((pace) => enabledWindows.has(pace.key) && pace.usable)
      : [],
  )

  // ── Painters ─────────────────────────────────────────────────────────────────────────────────
  // Painter lines are the same rolling windows over the same ladder, one line per painter per
  // enabled window. Colour says who, width says which window, exactly as for the template lines.
  const storedMetric = persisted<PainterMetric>('caelestis:painter-metric', 'placed')
  const painterMetric = $derived<PainterMetric>(
    PAINTER_METRICS.some((candidate) => candidate.key === storedMetric.value)
      ? storedMetric.value
      : 'placed',
  )
  const painterMetricNoun = $derived(
    PAINTER_METRICS.find((candidate) => candidate.key === painterMetric)?.noun ?? painterMetric,
  )
  /** The painter under the picker's pointer or keyboard, drawn on top with the others dimmed. */
  let spotlightPainter = $state<number | null>(null)

  /** One painter's cumulative points at a source's tier, zero-filled through complete buckets. */
  const painterPacePoints = (
    buckets: readonly PainterHistoryBucket[],
    wplaceUserId: number,
    resolution: number,
    coverageStart: number,
  ): PacePoint[] => {
    const byStart = new Map<number, number>()
    for (const bucket of buckets) {
      if (bucket.wplaceUserId !== wplaceUserId) continue
      byStart.set(
        bucket.bucketStart,
        (byStart.get(bucket.bucketStart) ?? 0) + bucket[painterMetric],
      )
    }
    const firstBucket = Math.ceil(coverageStart / resolution) * resolution
    const filled: PacePoint[] = []
    let cumPlaced = 0
    for (let t = firstBucket; t + resolution <= to; t += resolution) {
      cumPlaced += byStart.get(t) ?? 0
      filled.push({ t, cumPlaced })
    }
    return filled
  }

  interface PainterLine {
    readonly painter: PainterOption
    readonly window: (typeof PACE_WINDOWS)[number]['key']
    readonly rank: number
    readonly fullSeries: PaceRatePoint[]
  }

  // Each enabled window draws from its own retained painter source, fetched for the selected
  // painters only, at the tier the template line for that window would use.
  const painterLines = $derived.by<PainterLine[]>(() => {
    const lines: PainterLine[] = []
    PACE_WINDOWS.forEach((pace, index) => {
      if (!enabledWindows.has(pace.key)) return
      const source = painterHistories.find((candidate) => candidate.window === pace.key)?.history
      if (
        source?.resolution === undefined ||
        source.coverageStart === undefined ||
        !windowUsable(pace.seconds, source.resolution)
      )
        return
      for (const painter of painters) {
        if (!selectedPainters.has(painter.wplaceUserId)) continue
        const fullSeries = rollingPaceSeries(
          painterPacePoints(
            source.buckets,
            painter.wplaceUserId,
            source.resolution,
            source.coverageStart,
          ),
          source.resolution,
          pace.seconds,
        )
        if (fullSeries.length === 0) continue
        lines.push({
          painter,
          window: pace.key,
          rank: index / Math.max(1, PACE_WINDOWS.length - 1),
          fullSeries,
        })
      }
    })
    return lines
  })

  const chartSamples = $derived(
    mergeObservedProgress(
      archiveSamples,
      progressSamples,
      live || finished ? { at: to, correct: anchorCorrect, mismatched: anchorMismatched } : undefined,
    ),
  )
  /** Snap the crosshair to every vertex that is actually rendered, including retained fine data. */
  const hoverSnapTimes = $derived.by(() => {
    const times = new Set<number>()
    for (const sample of chartSamples) {
      if (sample.at >= shownView.from && sample.at <= shownView.to) times.add(sample.at)
    }
    for (const interval of visibleArchivePaces) {
      times.add(Math.max(interval.from, shownView.from))
      times.add(Math.min(interval.to, shownView.to))
    }
    for (const pace of activePaces) {
      for (const point of pace.series) times.add(point.t)
    }
    for (const line of activePainterLines) {
      for (const point of line.series) times.add(point.t)
    }
    return [...times].sort((a, b) => a - b)
  })

  /**
   * Ordered ramp anchored at two colours that are legible by construction: the shortest window is
   * the series blue itself, the longest is mostly foreground ink, and every step lies between
   * them. Ramping toward a surface or toward "light" always sinks one end into the background in
   * one theme or the other — that was the unreadable 30m line, twice.
   */
  const paceColor = (rank: number): string =>
    `color-mix(in oklab, var(--chart-placed) ${Math.round(100 - rank * 65)}%, var(--color-base-content))`
  const paceWidth = (rank: number): number => 1.5 + rank * 1.25

  // ── Geometry ─────────────────────────────────────────────────────────────────────────────────
  let width = $state(640)
  const height = 240
  const pad = { top: 18, right: 48, bottom: 22, left: 48 }
  const plotWidth = $derived(Math.max(1, width - pad.left - pad.right))
  const plotHeight = height - pad.top - pad.bottom

  // The axis tops come from the target window, so a zoom re-fits to where it is going.
  interface ProgressPoint extends PaceRatePoint {
    mismatched: number
    archive: boolean
  }
  const lerpProgress = (a: ProgressPoint, b: ProgressPoint, fraction: number): ProgressPoint => ({
    ...lerpRate(a, b, fraction),
    mismatched: a.mismatched + (b.mismatched - a.mismatched) * fraction,
    archive: a.archive || b.archive,
  })
  const progressSegments = $derived.by(() => {
    const segments: ProgressPoint[][] = []
    let segment: ProgressPoint[] | null = null
    for (const sample of chartSamples) {
      if (sample.correct === null || sample.mismatched === null) {
        segment = null
        continue
      }
      if (segment === null) {
        segment = []
        segments.push(segment)
      }
      const previous = segment.at(-1)
      if (
        previous !== undefined && segment.length > 1 &&
        segment.some((point) => point.archive) !== (previous.archive || sample.archive)
      ) {
        segment = [previous]
        segments.push(segment)
      }
      segment.push({
        t: sample.at, v: sample.correct, mismatched: sample.mismatched, archive: sample.archive,
      })
    }
    return segments
  })
  const archiveSnapshotPaces = $derived(archiveIntervals(archiveSamples))
  const archivePaces = $derived(archiveSnapshotPaces)
  const storedArchivePace = persisted<boolean>('caelestis:archive-net-pace', true)
  const drawnArchivePaces = $derived(storedArchivePace.value !== false ? archivePaces : [])
  const archivePaceSegments = $derived.by(() => {
    const segments: PaceRatePoint[][] = []
    let segment: PaceRatePoint[] | undefined
    for (const interval of drawnArchivePaces) {
      if (segment?.at(-1)?.t !== interval.from) {
        segment = [{ t: interval.from, v: interval.rate }]
        segments.push(segment)
      }
      segment?.push({ t: interval.to, v: interval.rate })
    }
    return segments
  })
  const paceOptions = $derived([
    ...paceWindows.map((pace, index) => ({
      key: pace.key,
      label: pace.key,
      colour: paceColor(index / (PACE_WINDOWS.length - 1)),
      selected: enabledWindows.has(pace.key),
      available: pace.usable || painterHistories.some((source) => source.window === pace.key && source.history.resolution !== undefined && windowUsable(pace.seconds, source.history.resolution) && source.history.buckets.length > 0),
      description: 'Rolling average',
    })),
    ...(archiveSamples.length === 0 ? [] : [{
      key: 'archive', label: 'Net progress', colour: 'var(--chart-placed)',
      selected: storedArchivePace.value !== false, available: archivePaces.length > 0,
      description: 'Between Eralyon snapshots',
    }]),
  ])
  const visibleProgressSegments = $derived(progressSegments.map((segment) => clipSeries(segment, shownView.from, shownView.to, lerpProgress)).filter((segment) => segment.length > 1))
  const isolatedProgressPoints = $derived(progressSegments.filter((segment) => segment.length === 1).flat().filter((point) => point.t >= shownView.from && point.t <= shownView.to))
  const visibleArchivePaces = $derived(drawnArchivePaces.filter((interval) => interval.to >= shownView.from && interval.from <= shownView.to))
  const visibleArchivePaceSegments = $derived(archivePaceSegments.map((segment) => clipSeries(segment, shownView.from, shownView.to, lerpRate)).filter((segment) => segment.length > 1))
  const targetArchivePaces = $derived(archivePaceSegments.flatMap((segment) => clipSeries(segment, view.from, view.to, lerpRate)))
  const rightMin = $derived(Math.min(0, ...targetArchivePaces.map((point) => point.v)))
  const leftScale = $derived(
    axisScale(Math.max(0, ...progressSegments.flatMap((segment) => clipSeries(segment, view.from, view.to, lerpProgress).map((point) => point.v + point.mismatched))), 4, 1),
  )
  const rightScale = $derived(
    axisScale(
      Math.max(
        0,
        ...targetArchivePaces.map((point) => point.v),
        ...enabledPaces.flatMap((pace) =>
          clipSeries(pace.fullSeries, view.from, view.to, lerpRate).map((point) => point.v),
        ),
        ...painterLines.flatMap((line) =>
          clipSeries(line.fullSeries, view.from, view.to, lerpRate).map((point) => point.v),
        ),
      ),
      4,
    ),
  )

  // ── Refit ────────────────────────────────────────────────────────────────────────────────────
  // The drawn domain and both axis tops chase their targets, so a preset, a plot-drag zoom, or a
  // toggled pace line re-fits the plot instead of snapping it. A brush drag moves the window
  // under the pointer while the axis tops keep gliding, and reduced motion turns every tween and
  // transition into a cut.
  const REFIT_MS = 400
  const reduceMotion =
    typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)')
  const motion = (ms: number): number => (reduceMotion?.matches ? 0 : ms)
  // The tweens start on the first frame's targets; the effects below keep them chasing.
  const shownWindow = new Tween(
    untrack(() => ({ from: view.from, to: view.to })),
    { duration: REFIT_MS, easing: cubicOut },
  )
  const shownAxes = new Tween(
    untrack(() => ({ leftMax: leftScale.max, rightMax: rightScale.max })),
    { duration: REFIT_MS, easing: cubicOut },
  )
  $effect(() => {
    const duration = brushDrag === null ? motion(REFIT_MS) : 0
    void shownWindow.set({ from: view.from, to: view.to }, { duration })
  })
  $effect(() => {
    void shownAxes.set(
      { leftMax: leftScale.max, rightMax: rightScale.max },
      { duration: motion(REFIT_MS) },
    )
  })
  const shownView = $derived<TimeWindow>({
    from: shownWindow.current.from,
    to: shownWindow.current.to,
  })
  const activePaces = $derived(
    enabledPaces.map((pace) => {
      const series = clipSeries(pace.fullSeries, shownView.from, shownView.to, lerpRate)
      const last = series[series.length - 1]
      if (last !== undefined && last.t < shownView.to) series.push({ ...last, t: shownView.to })
      return {
        ...pace,
        rank:
          PACE_WINDOWS.findIndex((x) => x.key === pace.key) /
          Math.max(1, PACE_WINDOWS.length - 1),
        series,
      }
    }),
  )

  const activePainterLines = $derived(
    painterLines.map((line) => {
      const series = clipSeries(line.fullSeries, shownView.from, shownView.to, lerpRate)
      const last = series[series.length - 1]
      if (last !== undefined && last.t < shownView.to) series.push({ ...last, t: shownView.to })
      return { ...line, series }
    }),
  )
  const painterLineOpacity = (wplaceUserId: number): number =>
    spotlightPainter === null || spotlightPainter === wplaceUserId ? 0.9 : 0.25

  const x = $derived(
    (t: number) =>
      pad.left + ((t - shownView.from) / Math.max(1, shownView.to - shownView.from)) * plotWidth,
  )
  const yLeft = $derived(
    (v: number) => height - pad.bottom - (v / shownAxes.current.leftMax) * plotHeight,
  )
  const yRight = $derived(
    (v: number) => height - pad.bottom - ((v - rightMin) / (shownAxes.current.rightMax - rightMin)) * plotHeight,
  )
  /** The time under a pointer, given the plot's left edge and displayed domain. */
  const timeIn = (range: TimeWindow, clientX: number, left: number): number =>
    range.from + ((clientX - left - pad.left) / plotWidth) * (range.to - range.from)
  const timeAt = (clientX: number, left: number): number => timeIn(shownView, clientX, left)

  const linePath = (series: readonly { t: number; v: number }[]): string =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yRight(p.v).toFixed(1)}`)
      .join('')

  const DAY_SECONDS = 86_400
  const tickStep = $derived(timeTickStep(shownView.to - shownView.from, plotWidth))

  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    for (let t = Math.ceil(shownView.from / tickStep) * tickStep; t < shownView.to; t += tickStep) {
      ticks.push(t)
    }
    return ticks
  })

  const formatTick = (t: number): string => {
    const date = new Date(t * 1000)
    const rangeStart = new Date(shownView.from * 1_000)
    const rangeEnd = new Date((shownView.to - 1) * 1_000)
    const crossesDay =
      rangeStart.getFullYear() !== rangeEnd.getFullYear() ||
      rangeStart.getMonth() !== rangeEnd.getMonth() ||
      rangeStart.getDate() !== rangeEnd.getDate()
    const crossesOffset = rangeStart.getTimezoneOffset() !== rangeEnd.getTimezoneOffset()
    if (!crossesDay) {
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        ...(crossesOffset ? { timeZoneName: 'shortOffset' } : {}),
      })
    }
    const crossesYear = rangeStart.getFullYear() !== rangeEnd.getFullYear()
    return date.toLocaleString(undefined, {
      ...(crossesYear ? { year: 'numeric' } : {}),
      month: 'short',
      day: 'numeric',
      ...(tickStep < DAY_SECONDS || crossesOffset ? { hour: '2-digit', minute: '2-digit' } : {}),
      ...(crossesOffset ? { timeZoneName: 'shortOffset' } : {}),
    })
  }

  const formatTime = (t: number): string =>
    new Date(t * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  // ── Hover ────────────────────────────────────────────────────────────────────────────────────
  interface HoverPoint {
    t: number
    cumCorrect: number | null
    cumMismatched: number | null
    archive: boolean
  }

  const interpolateValue = <T extends { t: number }>(
    series: readonly T[],
    t: number,
    value: (point: T) => number,
    clamp = false,
  ): number | null => {
    let previous: T | undefined
    for (const point of series) {
      if (point.t === t) return value(point)
      if (point.t > t) {
        if (previous === undefined) return clamp ? value(point) : null
        const fraction = (t - previous.t) / (point.t - previous.t)
        return value(previous) + (value(point) - value(previous)) * fraction
      }
      previous = point
    }
    return previous === undefined || !clamp ? null : value(previous)
  }

  let hover = $state<HoverPoint | null>(null)
  /** What the keyboard walk just landed on, for assistive technology. Pointer hovers stay quiet. */
  let announce = $state('')

  const hoverAt = (t: number | null): void => {
    if (t === null) {
      hover = null
      return
    }
    if (hover?.t === t) return
    const sample = chartSamples.find((sample) => sample.at === t)
    const cumCorrect = sample === undefined
      ? visibleProgressSegments.map(segment => interpolateValue(segment, t, point => point.v)).find(value => value !== null) ?? null
      : sample.correct
    const cumMismatched = sample === undefined
      ? visibleProgressSegments.map(segment => interpolateValue(segment, t, point => point.mismatched)).find(value => value !== null) ?? null
      : sample.mismatched
    hover = {
      t,
      cumCorrect: cumCorrect === null ? null : Math.round(cumCorrect),
      cumMismatched: cumMismatched === null ? null : Math.round(cumMismatched),
      archive: sample?.archive === true,
    }
  }

  const hoverArchivePace = $derived(hover === null ? undefined :
    visibleArchivePaces.find((interval) => hover !== null && hover.t > interval.from && hover.t <= interval.to) ??
    visibleArchivePaces.find((interval) => interval.from === hover?.t))
  const hoverArchiveRate = $derived.by(() => {
    if (hover === null) return null
    const t = hover.t
    return visibleArchivePaceSegments.map((segment) => interpolateValue(segment, t, (point) => point.v))
      .find((value) => value !== null) ?? null
  })

  const hoverPointer = (clientX: number, left: number): void =>
    hoverAt(nearestSorted(hoverSnapTimes, timeAt(clientX, left)))

  const hoverPace = (series: readonly { t: number; v: number }[], t: number): number | null =>
    interpolateValue(series, t, (point) => point.v)

  /** Each painter appears once, with their available rolling windows in chart order. */
  const hoverPaceRows = $derived.by(() => {
    if (hover === null) return []
    const { t } = hover
    const rows = new Map<
      string,
      { name: string; rates: { window: string; value: number; colour: string }[] }
    >()
    const add = (
      id: string,
      name: string,
      window: string,
      colour: string,
      series: readonly PaceRatePoint[],
    ): void => {
      const value = hoverPace(series, t)
      if (value === null) return
      const row = rows.get(id) ?? { name, rates: [] }
      row.rates.push({ window, value, colour })
      rows.set(id, row)
    }
    for (const pace of activePaces)
      add('all', 'All users', pace.key, paceColor(pace.rank), pace.series)
    for (const line of activePainterLines) {
      add(
        String(line.painter.wplaceUserId),
        painterLabel(line.painter),
        line.window,
        painterColour(line.painter.wplaceUserId),
        line.series,
      )
    }
    return [...rows].map(([id, row]) => ({ id, ...row }))
  })
  const hoverWindowCount = $derived(
    new Set([...activePaces.map(pace => pace.key), ...activePainterLines.map(line => line.window)]).size,
  )
  const hoverCardWidth = $derived(
    Math.min(Math.max(0, width - 16), Math.max(260, 140 + 112 * hoverWindowCount)),
  )

  /** The hover card pops from its anchored corner, on the transitions.dev tooltip timings. */
  const pop = (_node: Element, { duration }: { duration: number }): TransitionConfig => ({
    duration,
    easing: cubicOut,
    css: (t) => `opacity:${t};transform:scale(${0.98 + 0.02 * t})`,
  })

  const liveEdge = $derived(
    live && view.to === to ? { t: to, cumCorrect: anchorCorrect } : null,
  )

  const hoverSummary = (point: HoverPoint): string => {
    const paces = activePaces.flatMap((pace) => {
      const value = hoverPace(pace.series, point.t)
      return value === null ? [] : [`${pace.key} pace ${formatCount(value)} px/h`]
    })
    const painterPaces = activePainterLines.flatMap((line) => {
      const value = hoverPace(line.series, point.t)
      return value === null
        ? []
        : [
            `${painterLabel(line.painter)} ${line.window} ${painterMetricNoun} ${formatCount(value)} px/h`,
          ]
    })
    return [
      `${formatTime(point.t)}${liveEdge !== null && point.t === liveEdge.t ? ' (now)' : ''}`,
      ...(point.archive ? ['Eralyon snapshot'] : []),
      point.cumCorrect === null ? 'No completion coverage' : `${point.cumCorrect.toLocaleString()} correct`,
      point.cumMismatched === null ? 'No mismatch coverage' : `${point.cumMismatched.toLocaleString()} mismatched`,
      ...(hoverArchiveRate === null ? [] : [`Net progress ${formatCount(hoverArchiveRate)} px/h`]),
      ...paces,
      ...painterPaces,
    ].join(', ')
  }

  const onPlotKey = (event: KeyboardEvent): void => {
    const times = hoverSnapTimes
    if (times.length === 0) return
    const index = hover === null ? -1 : times.indexOf(hover.t)
    let next: number | undefined
    switch (event.key) {
      case 'ArrowLeft':
        next = times[index < 0 ? times.length - 1 : Math.max(0, index - 1)]
        break
      case 'ArrowRight':
        next = times[index < 0 ? times.length - 1 : Math.min(times.length - 1, index + 1)]
        break
      case 'Home':
        next = times[0]
        break
      case 'End':
        next = times[times.length - 1]
        break
      case 'Escape':
        if (hover !== null) hover = null
        else if (zoomed) resetWindow()
        else return
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    if (next === undefined) return
    hoverAt(next)
    announce = hover === null ? '' : hoverSummary(hover)
  }

  // ── Drag on the plot to zoom ─────────────────────────────────────────────────────────────────
  // Listeners live on `window` for the length of a drag, so the gesture keeps working when the
  // pointer leaves the plot, the strip, or even the page.
  // They attach synchronously: the next pointer event may arrive before any microtask runs.
  const listen = <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K]) => void,
  ): (() => void) => {
    window.addEventListener(type, handler)
    return () => window.removeEventListener(type, handler)
  }

  let plotDrag = $state<TimeWindow | null>(null)

  const onPlotPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || hoverSnapTimes.length === 0) return
    const plot = event.currentTarget as SVGSVGElement
    const dragView = { from: shownView.from, to: shownView.to }
    void shownWindow.set(dragView, { duration: 0 })
    const clampView = (t: number): number => Math.min(dragView.to, Math.max(dragView.from, t))
    const anchor = clampView(timeIn(dragView, event.clientX, plot.getBoundingClientRect().left))
    const startX = event.clientX
    let moved = false
    event.preventDefault()
    plot.focus({ preventScroll: true })
    let stops: (() => void)[] = []
    const finish = (clientX?: number, clientY?: number): void => {
      for (const stop of stops) stop()
      stops = []
      const drag = plotDrag
      plotDrag = null
      if (drag !== null) {
        selectWindow(
          clampWindow(
            {
              from: snapTime(Math.min(drag.from, drag.to), resolution, from, to),
              to: snapTime(Math.max(drag.from, drag.to), resolution, from, to),
            },
            from,
            to,
            MIN_SELECTION,
          ),
        )
      }
      if (clientX === undefined || clientY === undefined) return
      const bounds = plot.getBoundingClientRect()
      const inside =
        clientX >= bounds.left &&
        clientX <= bounds.right &&
        clientY >= bounds.top &&
        clientY <= bounds.bottom
      if (!inside) hover = null
    }
    stops = [
      listen('pointermove', (move) => {
        if (move.pointerId !== event.pointerId) return
        const left = plot.getBoundingClientRect().left
        const current = clampView(timeIn(dragView, move.clientX, left))
        if (!moved && Math.abs(move.clientX - startX) > 4) moved = true
        if (moved) plotDrag = { from: anchor, to: current }
        hoverPointer(move.clientX, left)
      }),
      listen('pointerup', (up) => {
        if (up.pointerId === event.pointerId) finish(up.clientX, up.clientY)
      }),
      listen('pointercancel', (cancel) => {
        if (cancel.pointerId === event.pointerId) finish()
      }),
    ]
  }

  // ── Brush strip ──────────────────────────────────────────────────────────────────────────────
  // The strip under the chart holds the whole fetched range in miniature. Drag a grip to resize
  // the window, drag the window to slide it, drag empty track to draw a fresh one.
  const BRUSH_HEIGHT = 40
  const brushPad = { top: 4, bottom: 4 }

  const bx = $derived((t: number) => pad.left + ((t - from) / Math.max(1, span)) * plotWidth)
  const brushTime = (clientX: number, left: number): number =>
    snapTime(from + ((clientX - left - pad.left) / plotWidth) * span, resolution, from, to)

  /** The full range's cumulative outline, the brush's little mountain. */
  const brushOutline = $derived.by(() => {
    if (points.length === 0) return ''
    const max = Math.max(1, ...points.map((p) => p.cumPlaced))
    const y = (v: number) =>
      BRUSH_HEIGHT - brushPad.bottom - (v / max) * (BRUSH_HEIGHT - brushPad.top - brushPad.bottom)
    const top = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${bx(p.t).toFixed(1)},${y(p.cumPlaced).toFixed(1)}`)
      .join('')
    const first = points[0]
    const last = points[points.length - 1]
    if (first === undefined || last === undefined) return ''
    return `${top}L${bx(last.t).toFixed(1)},${BRUSH_HEIGHT - brushPad.bottom}L${bx(first.t).toFixed(1)},${BRUSH_HEIGHT - brushPad.bottom}Z`
  })

  type Edge = 'head' | 'tail'
  type BrushDrag = Edge | 'move' | 'new'
  let brushDrag = $state<BrushDrag | null>(null)

  const BRUSH_TARGET_SIZE = 44
  const BRUSH_HANDLE_TARGET_SIZE = BRUSH_TARGET_SIZE * 1.5
  const brushWindowWidth = $derived(bx(view.to) - bx(view.from))
  const moveTargetWidth = $derived(Math.max(BRUSH_TARGET_SIZE, brushWindowWidth))
  const moveTargetLeft = $derived(
    (bx(view.from) + bx(view.to) - moveTargetWidth) / 2,
  )
  const keyStep = $derived(windowKeyStep(span, resolution))

  const onBrushPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const strip = event.currentTarget as HTMLDivElement
    const grip =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-handle]') : null
    const moveTarget =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-brush-move]')
        : null
    const t = brushTime(event.clientX, strip.getBoundingClientRect().left)
    const start = view
    const kind: BrushDrag =
      grip?.dataset.handle === 'head'
        ? 'head'
        : grip?.dataset.handle === 'tail'
          ? 'tail'
          : moveTarget !== null || (t > start.from && t < start.to)
            ? 'move'
            : 'new'
    const grabOffset = t - start.from
    const startX = event.clientX
    let moved = false
    brushDrag = kind
    event.preventDefault()
    grip?.focus({ preventScroll: true })
    let stops: (() => void)[] = []
    const finish = (): void => {
      for (const stop of stops) stop()
      stops = []
      brushDrag = null
    }
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return
      const current = brushTime(moveEvent.clientX, strip.getBoundingClientRect().left)
      if (!moved && Math.abs(moveEvent.clientX - startX) > 4) moved = true
      switch (kind) {
        case 'head':
          selectWindow({ from: Math.min(current, view.to - MIN_SELECTION), to: view.to })
          break
        case 'tail':
          selectWindow({ from: view.from, to: Math.max(current, view.from + MIN_SELECTION) })
          break
        case 'move': {
          const size = start.to - start.from
          const next = Math.min(to - size, Math.max(from, current - grabOffset))
          selectWindow({ from: next, to: next + size })
          break
        }
        case 'new':
          if (moved) selectWindow({ from: Math.min(t, current), to: Math.max(t, current) })
          break
      }
    }
    stops = [
      listen('pointermove', move),
      listen('pointerup', (up) => {
        if (up.pointerId === event.pointerId) finish()
      }),
      listen('pointercancel', (cancel) => {
        if (cancel.pointerId === event.pointerId) finish()
      }),
    ]
  }

  const onGripKey = (edge: Edge, event: KeyboardEvent): void => {
    const step = keyStep * (event.shiftKey ? 10 : 1)
    let delta: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        delta = -step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        delta = step
        break
      case 'PageDown':
        delta = -keyStep * 10
        break
      case 'PageUp':
        delta = keyStep * 10
        break
      case 'Home':
        selectWindow(
          edge === 'head'
            ? { from, to: view.to }
            : { from: view.from, to: view.from + MIN_SELECTION },
        )
        break
      case 'End':
        selectWindow(
          edge === 'head'
            ? { from: view.to - MIN_SELECTION, to: view.to }
            : { from: view.from, to },
        )
        break
      case 'Escape':
        resetWindow()
        break
      default:
        return
    }
    event.preventDefault()
    if (delta === null) return
    selectWindow(
      edge === 'head'
        ? { from: Math.min(view.to - MIN_SELECTION, Math.max(from, view.from + delta)), to: view.to }
        : {
            from: view.from,
            to: Math.max(view.from + MIN_SELECTION, Math.min(to, view.to + delta)),
          },
    )
  }

  const grips = $derived<readonly { edge: Edge; t: number; min: number; max: number }[]>([
    { edge: 'head', t: view.from, min: from, max: view.to - MIN_SELECTION },
    { edge: 'tail', t: view.to, min: view.from + MIN_SELECTION, max: to },
  ])

  // ── Range presets as a segmented control ────────────────────────────────────────────────────
  // JS measures the active button and writes its offset and width
  // onto the pill; CSS owns the tween. The first paint and every re-measure snap without a
  // transition, and a window that matches no preset hides the pill instead of parking it.
  let tabsBar = $state<HTMLDivElement | null>(null)
  let tabsPill = $state<HTMLSpanElement | null>(null)
  const activePreset = $derived(
    zoomed ? (presets.find((preset) => presetActive(preset.seconds))?.key ?? null) : 'all',
  )
  let pillKey: string | null | undefined

  const movePill = (pill: HTMLElement, tab: HTMLElement, animate: boolean): void => {
    if (!animate) {
      const previous = pill.style.transition
      pill.style.transition = 'none'
      pill.style.transform = `translateX(${tab.offsetLeft}px)`
      pill.style.width = `${tab.offsetWidth}px`
      void pill.offsetWidth
      pill.style.transition = previous
    } else {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`
      pill.style.width = `${tab.offsetWidth}px`
    }
  }

  $effect(() => {
    const bar = tabsBar
    const pill = tabsPill
    const key = activePreset
    if (bar === null || pill === null) return
    const button =
      key === null ? null : bar.querySelector<HTMLElement>(`[data-range-preset="${key}"]`)
    const animate = pillKey !== undefined && pillKey !== null && pillKey !== key
    pillKey = key
    if (button !== null) movePill(pill, button, animate)
  })

  $effect(() => {
    const bar = tabsBar
    const pill = tabsPill
    if (bar === null || pill === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const button =
        activePreset === null
          ? null
          : bar.querySelector<HTMLElement>(`[data-range-preset="${activePreset}"]`)
      if (button !== null) movePill(pill, button, false)
    })
    observer.observe(bar)
    return () => observer.disconnect()
  })

  const chartLabel = $derived(
    `Cumulative pixels painted and rolling pace from ${formatTime(view.from)} to ${formatTime(view.to)}${
      painters.length > 0
        ? `, with ${painterMetricNoun} pace lines for ${selectedPainters.size} of ${painters.length} painters`
        : ''
    }. Use the arrow keys to read values.`,
  )
</script>

<div class="flex flex-col gap-3" bind:clientWidth={width}>
  <div class="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
    <div class="flex items-center gap-4 text-base-content/70">
      <span class="inline-flex items-center gap-2">
        <span
          class="size-3 rounded-xs"
          style:background="var(--chart-correct)"
        ></span>
        correct
      </span>
      <span class="inline-flex items-center gap-2">
        <span class="size-3 rounded-xs bg-error"></span>
        mismatched
      </span>
    </div>

    <div class="flex items-center gap-2" role="group" aria-label="pace lines">
      <span class="text-base-content/65">pace</span>
      <PacePicker options={paceOptions} onToggle={(key) => {
        if (key === 'archive') storedArchivePace.value = !storedArchivePace.value
        else toggleWindow(key)
      }} />
    </div>

    {#if painters.length > 0 || paceWindows.some((pace) => pace.usable)}
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="whose pace lines">
        <span class="text-base-content/65">who</span>
        <PainterPicker
          options={painters}
          selected={selectedPainters}
          onToggle={onTogglePainter}
          {allUsersShown}
          onToggleAllUsers={() => {
            storedAllUsers.value = !allUsersShown
          }}
          onHover={(wplaceUserId) => {
            spotlightPainter = wplaceUserId
          }}
        />
        {#if painterLines.length > 0}
        <span class="text-base-content/65">painter metric</span>
        <SlidingTabs
          options={PAINTER_METRICS.map((candidate) => ({
            key: candidate.key,
            label: candidate.label,
            title: `Draw painter lines from ${candidate.noun}`,
          }))}
          value={painterMetric}
          label="painter metric"
          name="painter-metric"
          onselect={(key) => {
            storedMetric.value = key as PainterMetric
          }}
        />
        {/if}
      </div>
    {/if}

    {#if hasActivity}
      <div class="ms-auto flex items-center gap-2">
        <span class="text-base-content/65">range</span>
        <div
          class="t-tabs"
          role="group"
          aria-label="time range"
          data-empty={activePreset === null ? '' : undefined}
          bind:this={tabsBar}
        >
          <span class="t-tabs-pill" aria-hidden="true" bind:this={tabsPill}></span>
          {#each presets as preset (preset.key)}
            <button
              type="button"
              class="t-tab tabular-nums"
              aria-pressed={activePreset === preset.key}
              data-range-preset={preset.key}
              title="Show {preset.label}"
              onclick={() => selectPreset(preset.seconds)}
            >
              {preset.key}
            </button>
          {/each}
          <button
            type="button"
            class="t-tab"
            aria-pressed={activePreset === 'all'}
            data-range-preset="all"
            title="Show the whole history"
            onclick={resetWindow}
          >
            all
          </button>
        </div>
      </div>
    {/if}
  </div>

  {#if hasActivity}
    {#if archiveSamples.length > 0}
      <details class="text-xs text-base-content/65">
        <summary class="cursor-pointer">Eralyon: dashed progress and interval net pace. View snapshot values</summary>
        <div class="max-h-60 overflow-auto mt-2">
          <table class="w-full text-start tabular-nums">
            <caption class="text-start mb-2">Compared with the imported artwork version. Gaps have no completion or pace value.</caption>
            <thead><tr><th scope="col" class="text-start">Snapshot</th><th scope="col">Correct pixels</th><th scope="col">Net px/h since previous snapshot</th></tr></thead>
            <tbody>
              {#each archiveSamples as sample (sample.at)}
                <tr><th scope="row" class="text-start font-normal">{formatTime(sample.at)}</th><td class="text-center">{sample.correct === null ? 'No coverage' : sample.correct.toLocaleString()}</td><td class="text-center">{archiveSnapshotPaces.find((interval) => interval.to === sample.at)?.rate.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? '—'}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
    {/if}
    <div class="relative">
      <!-- The image is focusable so keyboard users can walk the data points; the live region below
           reads each one out. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <svg
        {width}
        {height}
        role="img"
        tabindex="0"
        aria-label={chartLabel}
        class="block touch-pan-y cursor-crosshair rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        onpointermove={(event) => {
          if (plotDrag === null && brushDrag === null) {
            hoverPointer(event.clientX, event.currentTarget.getBoundingClientRect().left)
          }
        }}
        onpointerleave={() => {
          if (plotDrag === null) hover = null
        }}
        onpointerdown={onPlotPointerDown}
        ondblclick={resetWindow}
        onkeydown={onPlotKey}
      >
        {#each leftScale.ticks as tick (tick)}
          {#if yLeft(tick) >= pad.top}
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={yLeft(tick)}
              y2={yLeft(tick)}
              class="stroke-base-content/10"
            />
            <text
              x={pad.left - 8}
              y={yLeft(tick) + 3}
              text-anchor="end"
              aria-label={formatPixels(tick)}
              class="fill-base-content/50 text-[10px] tabular-nums"><title>{formatPixels(tick)}</title>{formatCount(tick)}</text
            >
          {/if}
        {/each}
        {#if activePaces.length > 0 || archivePaces.length > 0}
          {#if rightMin < 0}
            <text x={width - pad.right + 8} y={yRight(rightMin) + 3} class="fill-base-content/50 text-[10px] tabular-nums">{formatCount(rightMin)}</text>
          {/if}
          {#each rightScale.ticks as tick (tick)}
            {#if yRight(tick) >= pad.top}
              <text
                x={width - pad.right + 8}
                y={yRight(tick) + 3}
                text-anchor="start"
                aria-label={`${formatPixels(tick)} per hour`}
                class="fill-base-content/40 text-[10px] tabular-nums"
                ><title>{formatPixels(tick)} per hour</title>{formatCount(tick)}</text
              >
            {/if}
          {/each}
        {/if}
        <text x={pad.left - 8} y={9} text-anchor="end" class="fill-base-content/40 text-[9px]">px</text>
        {#if activePaces.length > 0 || archivePaces.length > 0}
          <text x={width - pad.right + 8} y={9} text-anchor="start" class="fill-base-content/40 text-[9px]"
            >px/h</text
          >
        {/if}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          class="stroke-base-content/20"
        />
        {#each xTicks as tick (tick)}
          <line
            x1={x(tick)}
            x2={x(tick)}
            y1={height - pad.bottom}
            y2={height - pad.bottom + 4}
            class="stroke-base-content/20"
          />
          <text
            data-axis="time"
            x={x(tick)}
            y={height - 6}
            text-anchor="middle"
            class="fill-base-content/50 text-[10px] tabular-nums"
          >
            {formatTick(tick)}
          </text>
        {/each}

        <g class="chart-reveal">
          {#each activePaces as pace (pace.key)}
            <path
              in:fade={{ duration: motion(250) }}
              out:fade={{ duration: motion(150) }}
              data-pace-window={pace.key}
              data-series-start={pace.fullSeries[0]?.t}
              data-series-first-value={pace.fullSeries[0]?.v}
              d={linePath(pace.series)}
              fill="none"
              stroke={paceColor(pace.rank)}
              stroke-width={paceWidth(pace.rank)}
              stroke-linejoin="round"
            />
          {/each}

          {#each visibleProgressSegments as segment (segment[0].t)}
            {@const archived = segment.some(point => point.archive)}
            {@const line = segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${yLeft(point.v).toFixed(1)}`).join('')}
            {@const mismatchedLine = segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${yLeft(point.v + point.mismatched).toFixed(1)}`).join('')}
            <path data-archive-progress-area
              d={`${line}L${x(segment[segment.length - 1].t).toFixed(1)},${yLeft(0).toFixed(1)}L${x(segment[0].t).toFixed(1)},${yLeft(0).toFixed(1)}Z`}
              fill="var(--chart-correct)" opacity="0.3" />
            <path data-archive-mismatched-area
              d={`${mismatchedLine}${[...segment].reverse().map((point) => `L${x(point.t).toFixed(1)},${yLeft(point.v).toFixed(1)}`).join('')}Z`}
              class="fill-error" opacity="0.25" />
            {#if segment.some((point) => point.mismatched > 0)}
              <path data-archive-mismatched d={mismatchedLine} fill="none" class="stroke-error"
                stroke-width="1.5" stroke-dasharray={archived ? '5 4' : undefined} stroke-linejoin="round" />
            {/if}
            <path data-archive-progress d={line} fill="none" stroke="var(--chart-correct)"
              stroke-width="1.5" stroke-dasharray={archived ? '5 4' : undefined} stroke-linejoin="round" />
          {/each}

          {#each visibleArchivePaceSegments as segment (segment[0].t)}
            <path data-archive-pace d={linePath(segment)} fill="none"
              stroke="var(--chart-placed)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" />
          {/each}

          {#each isolatedProgressPoints as point (point.t)}
            <g data-archive-singleton>
              <path d={`M${Math.max(pad.left, x(point.t) - 3)},${yLeft(point.v)}H${Math.min(width - pad.right, x(point.t) + 3)}`}
                stroke="var(--chart-correct)" stroke-width="2" />
              {#if point.mismatched > 0}<path d={`M${Math.max(pad.left, x(point.t) - 3)},${yLeft(point.v + point.mismatched)}H${Math.min(width - pad.right, x(point.t) + 3)}`}
                class="stroke-error" stroke-width="2" />{/if}
            </g>
          {/each}

          {#each activePainterLines as line (`${line.painter.wplaceUserId}:${line.window}`)}
            <path
              in:fade={{ duration: motion(250) }}
              out:fade={{ duration: motion(150) }}
              data-painter-line={line.painter.wplaceUserId}
              data-pace-window={line.window}
              d={linePath(line.series)}
              fill="none"
              stroke={painterColour(line.painter.wplaceUserId)}
              stroke-width={paceWidth(line.rank)}
              stroke-opacity={painterLineOpacity(line.painter.wplaceUserId)}
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/each}

          {#if liveEdge !== null}
            <circle
              cx={x(liveEdge.t)}
              cy={yLeft(liveEdge.cumCorrect)}
              r="4"
              fill="var(--chart-correct)"
              class="motion-safe:animate-ping"
              style:transform-box="fill-box"
              style:transform-origin="center"
              opacity="0.6"
            />
            <circle
              cx={x(liveEdge.t)}
              cy={yLeft(liveEdge.cumCorrect)}
              r="3"
              fill="var(--chart-correct)"
              class="stroke-base-100"
              stroke-width="1.5"
            />
          {/if}
        </g>

        {#if plotDrag !== null}
          <rect
            data-plot-selection
            out:fade={{ duration: motion(150) }}
            x={Math.min(x(plotDrag.from), x(plotDrag.to))}
            y={pad.top}
            width={Math.abs(x(plotDrag.to) - x(plotDrag.from))}
            height={plotHeight}
            class="fill-primary/10 stroke-primary/50"
          />
        {/if}

        {#if hover !== null}
          <g in:fade={{ duration: motion(150) }} out:fade={{ duration: motion(100) }}>
            <line
              data-crosshair
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={pad.top}
              y2={height - pad.bottom}
              class="stroke-base-content/25"
            />
            {#if hover.cumCorrect !== null}<circle
              cx={x(hover.t)}
              cy={yLeft(hover.cumCorrect)}
              r="3"
              fill="var(--chart-correct)"
              class="stroke-base-100"
              stroke-width="1.5"
            />{/if}
            {#if hoverArchiveRate !== null}
              <circle cx={x(hover.t)} cy={yRight(hoverArchiveRate)} r="3" fill="var(--chart-placed)" class="stroke-base-100" stroke-width="1.5" />
            {/if}
            {#each activePaces as pace (pace.key)}
              {@const value = hoverPace(pace.series, hover.t)}
              {#if value !== null}
                <circle
                  cx={x(hover.t)}
                  cy={yRight(value)}
                  r="3"
                  fill={paceColor(pace.rank)}
                  class="stroke-base-100"
                  stroke-width="1.5"
                />
              {/if}
            {/each}
            {#each activePainterLines as line (`${line.painter.wplaceUserId}:${line.window}`)}
              {@const value = hoverPace(line.series, hover.t)}
              {#if value !== null}
                <circle
                  cx={x(hover.t)}
                  cy={yRight(value)}
                  r="3"
                  fill={painterColour(line.painter.wplaceUserId)}
                  class="stroke-base-100"
                  stroke-width="1.5"
                />
              {/if}
            {/each}
          </g>
        {/if}
      </svg>

      {#if hover !== null}
        <div
          class="pointer-events-none absolute z-10 rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-sm"
          data-pace-tooltip
          in:pop={{ duration: motion(150) }}
          out:pop={{ duration: motion(100) }}
          style:transform-origin={x(hover.t) > width * 0.55 ? '100% 0' : '0 0'}
          style:top="{pad.top}px"
          style:width="{hoverCardWidth}px"
          style:left="{Math.max(8, Math.min(width - hoverCardWidth - 8, x(hover.t) > width * 0.55 ? x(hover.t) - hoverCardWidth - 12 : x(hover.t) + 12))}px"
        >
          <div class="font-medium tabular-nums">
            {formatTime(hover.t)}{#if liveEdge !== null && hover.t === liveEdge.t}
              <span class="ms-1 text-base-content/50">now</span>{/if}
          </div>
          {#if hover.archive}<div class="text-base-content/60">Eralyon snapshot</div>{/if}
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-xs" style:background="var(--chart-correct)"></span>
              <span class="text-base-content/70">correct</span>
              <span>{hover.cumCorrect?.toLocaleString() ?? 'No coverage'}</span>
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-xs bg-error"></span>
              <span class="text-base-content/70">mismatched</span>
              <span>{hover.cumMismatched?.toLocaleString() ?? 'No coverage'}</span>
            </span>
          </div>
          {#if hoverArchivePace !== undefined && hoverArchiveRate !== null}
            <div data-archive-hover class="mt-2 border-t border-base-300 pt-1.5">
              <div class="flex justify-between gap-3"><span>Net progress</span><span>{formatExactCount(Math.round(hoverArchiveRate * 100) / 100)} px/h</span></div>
              <div class="mt-0.5 text-base-content/60">{#if hoverArchiveRate !== hoverArchivePace.rate}Interpolated between pace samples{:else}{formatTime(hoverArchivePace.from)} → {formatTime(hoverArchivePace.to)}{/if}</div>
            </div>
          {/if}
          {#if hoverPaceRows.length > 0}
            <div class="mt-2 flex items-center justify-between border-t border-base-300 pt-1.5 text-base-content/60">
              <span>Pace</span><span>px/h</span>
            </div>
            <div class="divide-y divide-base-300/60 tabular-nums">
              {#each hoverPaceRows as row (row.id)}
                <div data-pace-row={row.id} class="grid items-start gap-x-3 gap-y-1 py-1.5 {hoverCardWidth < 480 && hoverWindowCount > 2 ? 'grid-cols-1' : 'grid-cols-[6rem_minmax(0,1fr)]'}">
                  <span class="break-words font-medium">{row.name}</span>
                  <div class="grid gap-x-3 gap-y-1" style:grid-template-columns="repeat(auto-fit, minmax(5.5rem, 1fr))">
                    {#each row.rates as rate (rate.window)}
                      <span data-pace-rate={rate.window} class="flex items-center gap-1 whitespace-nowrap">
                        <span class="size-1.5 shrink-0 rounded-full" style:background={rate.colour} aria-hidden="true"></span>
                        <span class="text-base-content/70">{rate.window}</span>
                        <span class="ms-auto">{formatExactCount(Math.round(rate.value * 10) / 10)}</span>
                      </span>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="sr-only" aria-live="polite">{announce}</div>
    </div>

    <!-- The strip is a pointer gesture surface; its keyboard equivalent is the two grips inside. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="relative isolate touch-none select-none {brushDrag === 'move'
        ? 'cursor-grabbing'
        : brushDrag === 'head' || brushDrag === 'tail'
          ? 'cursor-ew-resize'
          : 'cursor-crosshair'}"
      style:height="{BRUSH_HEIGHT}px"
      role="group"
      aria-label="time window"
      title="Drag to choose the time window. Double-click to show everything."
      onpointerdown={onBrushPointerDown}
      ondblclick={resetWindow}
    >
      <svg {width} height={BRUSH_HEIGHT} class="block" aria-hidden="true">
        <rect
          x={pad.left}
          y={brushPad.top}
          width={plotWidth}
          height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
          rx="4"
          class="fill-base-200"
        />
        <path class="chart-reveal" d={brushOutline} fill="var(--chart-placed)" opacity="0.35" />
        <rect
          data-brush-window
          x={bx(view.from)}
          y={brushPad.top}
          width={Math.max(0, bx(view.to) - bx(view.from))}
          height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
          class="fill-primary/15 stroke-primary/70 {brushDrag === 'move' ? 'cursor-grabbing' : 'cursor-grab'}"
        />
      </svg>
      {#if zoomed}
        <span
          data-brush-move
          class="absolute inset-y-0 z-20 cursor-grab"
          style:left="{moveTargetLeft}px"
          style:width="{moveTargetWidth}px"
          aria-hidden="true"
        ></span>
      {/if}
      {#each grips as grip (grip.edge)}
        <span
          role="slider"
          tabindex="0"
          data-handle={grip.edge}
          aria-label={grip.edge === 'head' ? 'window start' : 'window end'}
          aria-orientation="horizontal"
          aria-valuemin={grip.min}
          aria-valuemax={grip.max}
          aria-valuenow={grip.t}
          aria-valuetext={formatTime(grip.t)}
          class="group absolute inset-y-0 z-10 flex cursor-ew-resize items-center outline-none {grip.edge ===
          'head'
            ? 'justify-end'
            : 'justify-start'}"
          style:left="{grip.edge === 'head' ? bx(grip.t) - BRUSH_HANDLE_TARGET_SIZE : bx(grip.t)}px"
          style:width="{BRUSH_HANDLE_TARGET_SIZE}px"
          onkeydown={(event) => onGripKey(grip.edge, event)}
        >
          <span
            class="h-[calc(100%-8px)] w-1.5 rounded-xs bg-primary ring-1 ring-base-100 group-focus-visible:ring-2 group-focus-visible:ring-primary/60 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-base-100"
            aria-hidden="true"
          ></span>
        </span>
      {/each}
    </div>
  {:else}
    <div
      class="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/50"
    >
      No paint activity reported in this window.
    </div>
  {/if}
</div>
