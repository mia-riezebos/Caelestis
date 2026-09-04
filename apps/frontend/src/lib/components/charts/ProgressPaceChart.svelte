<script lang="ts">
  import { formatCount, formatExactCount, formatPixels, type HistoryBucket } from '@caelestis/shared'
  import { persisted } from '$lib/persisted.svelte'
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
    rollingPaceSeries,
    snapTime,
    timeTickStep,
    type TimeWindow,
    windowKeyStep,
  } from '$lib/components/charts/progress-pace'

  let {
    buckets,
    paceHistories = [],
    resolution,
    from,
    to,
    anchorCorrect,
    anchorMismatched,
    live = false,
  }: {
    buckets: readonly HistoryBucket[]
    /** One server-selected retained source for each rolling window. */
    paceHistories?: readonly PaceHistorySource[]
    /** Bucket width in seconds; buckets are summed across templates per bucket start. */
    resolution: number
    from: number
    to: number
    /**
     * The template's live status right now, from `/telemetry/status` — canvas truth, not reports.
     * The progress areas walk backwards from these anchors along the reported deltas, so the
     * right edge always equals the meter above and the areas read as overall template progress.
     * The pace lines stay purely report-derived.
     */
    anchorCorrect: number
    anchorMismatched: number
    /** The right edge is now: the canvas is still being painted, so the last point is live. */
    live?: boolean
  } = $props()

  /**
   * Fetch deltas once and derive each chart series here. Stacked areas show correct and mismatched
   * pixels. Rolling pace windows use the right axis. Longer windows use darker, thicker lines.
   */
  const storedWindows = persisted<string[]>('caelestis:pace-windows', ['1h', '6h'])
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
    correct: number
    cumCorrect: number
    cumMismatched: number
    cumPlaced: number
  }

  const points = $derived.by<Point[]>(() => {
    if (buckets.length === 0) return []
    const byStart = new Map<number, { placed: number; correct: number; repairs: number }>()
    for (const bucket of buckets) {
      const entry = byStart.get(bucket.bucketStart) ?? { placed: 0, correct: 0, repairs: 0 }
      entry.placed += bucket.placed
      entry.correct += bucket.correct
      entry.repairs += bucket.repairs
      byStart.set(bucket.bucketStart, entry)
    }
    const filled: Point[] = []
    let cumCorrect = 0
    let cumPlaced = 0
    let cumMismatched = 0
    const first = Math.ceil(from / resolution) * resolution
    for (let t = first; t < to; t += resolution) {
      const delta = byStart.get(t) ?? { placed: 0, correct: 0, repairs: 0 }
      cumCorrect += delta.correct
      cumPlaced += delta.placed
      // A mismatch is born by a wrong placement and killed by a repair. `placed - correct` is the
      // wrong placements; each repair converts one wrong pixel to correct. Without the repairs
      // term the band could never slope down, which read as "my fixes aren't counting".
      cumMismatched += delta.placed - delta.correct - delta.repairs
      filled.push({
        t,
        placed: delta.placed,
        correct: delta.correct,
        cumCorrect,
        cumMismatched,
        cumPlaced,
      })
    }
    // Anchor to live state: shift each series so its right edge equals what the canvas says now.
    // Reported deltas only shape the slope between observations; the level is the server's truth.
    const last = filled[filled.length - 1]
    if (last !== undefined) {
      const correctShift = anchorCorrect - last.cumCorrect
      const mismatchedShift = anchorMismatched - last.cumMismatched
      for (const point of filled) {
        point.cumCorrect = Math.max(0, point.cumCorrect + correctShift)
        point.cumMismatched = Math.max(0, point.cumMismatched + mismatchedShift)
      }
    }
    return filled
  })

  const hasActivity = $derived(points.some((p) => p.placed > 0))

  // ── Time window ──────────────────────────────────────────────────────────────────────────────
  // `null` shows the whole fetched range. Everything below reads the clamped `view`, so a window
  // chosen before a re-fetch can never point outside the data. Pace and cumulatives are still
  // derived from the full data, so a window's left edge shows real values, not a restart from zero.
  let selection = $state<TimeWindow | null>(null)
  const span = $derived(to - from)
  const MIN_SELECTION = $derived(Math.min(span, resolution * 6))
  const view = $derived<TimeWindow>(
    selection === null ? { from, to } : clampWindow(selection, from, to, MIN_SELECTION),
  )
  const zoomed = $derived(view.from > from || view.to < to)
  const resetWindow = (): void => {
    selection = null
  }

  const presets = $derived(availableRangePresets(span, MIN_SELECTION))
  const presetWindow = (seconds: number): TimeWindow => ({
    from: snapTime(to - seconds, resolution, from, to),
    to,
  })
  const presetActive = (seconds: number): boolean =>
    view.to === to && view.from === presetWindow(seconds).from

  const lerpPoint = (a: Point, b: Point, fraction: number): Point => ({
    t: a.t + (b.t - a.t) * fraction,
    placed: 0,
    correct: 0,
    cumCorrect: a.cumCorrect + (b.cumCorrect - a.cumCorrect) * fraction,
    cumMismatched: a.cumMismatched + (b.cumMismatched - a.cumMismatched) * fraction,
    cumPlaced: a.cumPlaced + (b.cumPlaced - a.cumPlaced) * fraction,
  })
  const lerpRate = (a: PaceRatePoint, b: PaceRatePoint, fraction: number): PaceRatePoint => ({
    t: a.t + (b.t - a.t) * fraction,
    v: a.v + (b.v - a.v) * fraction,
  })

  const visiblePoints = $derived.by(() => {
    const clipped = clipSeries(points, view.from, view.to, lerpPoint)
    const last = clipped[clipped.length - 1]
    const newest = points[points.length - 1]
    // The newest bucket is still filling: hold its level out to the right edge so the areas meet
    // "now" instead of stopping one bucket short of it.
    if (last !== undefined && newest !== undefined && last.t === newest.t && last.t < view.to) {
      clipped.push({ ...last, t: view.to, placed: 0, correct: 0 })
    }
    return clipped
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
    for (let t = firstBucket; t < to; t += paceResolution) {
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
        ? { points, resolution }
        : retained?.history.resolution !== undefined &&
            windowUsable(pace.seconds, retained.history.resolution)
          ? { points: retainedPacePoints(retained), resolution: retained.history.resolution }
          : null
      const fullSeries =
        source === null ? [] : rollingPaceSeries(source.points, source.resolution, pace.seconds)
      return { ...pace, usable: fullSeries.length > 0, fullSeries }
    }),
  )

  const activePaces = $derived(
    paceWindows
      .filter((pace) => enabledWindows.has(pace.key) && pace.usable)
      .map((pace) => ({
        ...pace,
        rank:
          PACE_WINDOWS.findIndex((x) => x.key === pace.key) / Math.max(1, PACE_WINDOWS.length - 1),
        series: clipSeries(pace.fullSeries, view.from, view.to, lerpRate),
      })),
  )

  /** Snap the crosshair to every vertex that is actually rendered, including retained fine data. */
  const hoverSnapTimes = $derived.by(() => {
    const times = new Set(visiblePoints.map((point) => point.t))
    for (const pace of activePaces) {
      for (const point of pace.series) times.add(point.t)
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

  const leftScale = $derived(
    axisScale(Math.max(0, ...visiblePoints.map((p) => p.cumCorrect + p.cumMismatched)), 4, 1),
  )
  const rightScale = $derived(
    axisScale(Math.max(0, ...activePaces.flatMap((p) => p.series.map((s) => s.v))), 4),
  )

  const x = $derived(
    (t: number) => pad.left + ((t - view.from) / Math.max(1, view.to - view.from)) * plotWidth,
  )
  const yLeft = $derived(
    (v: number) => height - pad.bottom - (v / leftScale.max) * plotHeight,
  )
  const yRight = $derived(
    (v: number) => height - pad.bottom - (v / rightScale.max) * plotHeight,
  )
  /** The time under a pointer, given the plot's left edge on screen. */
  const timeAt = (clientX: number, left: number): number =>
    view.from + ((clientX - left - pad.left) / plotWidth) * (view.to - view.from)

  const linePath = (series: readonly { t: number; v: number }[]): string =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yRight(p.v).toFixed(1)}`)
      .join('')

  /** Stacked band between two cumulative levels, closed into a fillable region. */
  const bandPath = (lower: (p: Point) => number, upper: (p: Point) => number): string => {
    if (visiblePoints.length === 0) return ''
    const top = visiblePoints
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yLeft(upper(p)).toFixed(1)}`)
      .join('')
    const bottom = [...visiblePoints]
      .reverse()
      .map((p) => `L${x(p.t).toFixed(1)},${yLeft(lower(p)).toFixed(1)}`)
      .join('')
    return `${top}${bottom}Z`
  }

  const DAY_SECONDS = 86_400
  const tickStep = $derived(timeTickStep(view.to - view.from, plotWidth))

  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    for (let t = Math.ceil(view.from / tickStep) * tickStep; t < view.to; t += tickStep) {
      ticks.push(t)
    }
    return ticks
  })

  const formatTick = (t: number): string => {
    const date = new Date(t * 1000)
    const rangeStart = new Date(view.from * 1_000)
    const rangeEnd = new Date((view.to - 1) * 1_000)
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
    cumCorrect: number
    cumMismatched: number
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
    const cumCorrect = interpolateValue(visiblePoints, t, (point) => point.cumCorrect, true)
    const cumMismatched = interpolateValue(visiblePoints, t, (point) => point.cumMismatched, true)
    if (cumCorrect === null || cumMismatched === null) return
    hover = { t, cumCorrect: Math.round(cumCorrect), cumMismatched: Math.round(cumMismatched) }
  }

  const hoverPointer = (clientX: number, left: number): void =>
    hoverAt(nearestSorted(hoverSnapTimes, timeAt(clientX, left)))

  const hoverPace = (series: readonly { t: number; v: number }[], t: number): number | null =>
    interpolateValue(series, t, (point) => point.v)

  const liveEdge = $derived(
    live && view.to === to ? (visiblePoints[visiblePoints.length - 1] ?? null) : null,
  )

  const hoverSummary = (point: HoverPoint): string => {
    const paces = activePaces.flatMap((pace) => {
      const value = hoverPace(pace.series, point.t)
      return value === null ? [] : [`${pace.key} pace ${formatCount(value)} px/h`]
    })
    return [
      `${formatTime(point.t)}${liveEdge !== null && point.t === liveEdge.t ? ' (now)' : ''}`,
      `${point.cumCorrect.toLocaleString()} correct`,
      `${point.cumMismatched.toLocaleString()} mismatched`,
      ...paces,
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
    const clampView = (t: number): number => Math.min(view.to, Math.max(view.from, t))
    const anchor = clampView(timeAt(event.clientX, plot.getBoundingClientRect().left))
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
        selection = clampWindow(
          {
            from: snapTime(Math.min(drag.from, drag.to), resolution, from, to),
            to: snapTime(Math.max(drag.from, drag.to), resolution, from, to),
          },
          from,
          to,
          MIN_SELECTION,
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
        const current = clampView(timeAt(move.clientX, left))
        if (!moved && Math.abs(move.clientX - startX) > 4) moved = true
        if (moved) plotDrag = { from: anchor, to: current }
        hoverPointer(move.clientX, left)
      }),
      listen('pointerup', (up) => {
        if (up.pointerId === event.pointerId) finish(up.clientX, up.clientY)
      }),
      listen('pointercancel', () => finish()),
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

  /** Grips get a 44px touch target, shrinking only when the window itself is narrower than two. */
  const gripHitWidth = $derived(Math.min(44, Math.max(12, (bx(view.to) - bx(view.from)) / 2)))
  const keyStep = $derived(windowKeyStep(span, resolution))

  const onBrushPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const strip = event.currentTarget as HTMLDivElement
    const grip =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-handle]') : null
    const t = brushTime(event.clientX, strip.getBoundingClientRect().left)
    const start = view
    const kind: BrushDrag =
      grip?.dataset.handle === 'head'
        ? 'head'
        : grip?.dataset.handle === 'tail'
          ? 'tail'
          : t > start.from && t < start.to
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
          selection = { from: Math.min(current, view.to - MIN_SELECTION), to: view.to }
          break
        case 'tail':
          selection = { from: view.from, to: Math.max(current, view.from + MIN_SELECTION) }
          break
        case 'move': {
          const size = start.to - start.from
          const next = Math.min(to - size, Math.max(from, current - grabOffset))
          selection = { from: next, to: next + size }
          break
        }
        case 'new':
          if (moved) selection = { from: Math.min(t, current), to: Math.max(t, current) }
          break
      }
    }
    stops = [
      listen('pointermove', move),
      listen('pointerup', (up) => {
        if (up.pointerId === event.pointerId) finish()
      }),
      listen('pointercancel', finish),
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
        selection =
          edge === 'head'
            ? { from, to: view.to }
            : { from: view.from, to: view.from + MIN_SELECTION }
        break
      case 'End':
        selection =
          edge === 'head'
            ? { from: view.to - MIN_SELECTION, to: view.to }
            : { from: view.from, to }
        break
      case 'Escape':
        resetWindow()
        break
      default:
        return
    }
    event.preventDefault()
    if (delta === null) return
    selection =
      edge === 'head'
        ? { from: Math.min(view.to - MIN_SELECTION, Math.max(from, view.from + delta)), to: view.to }
        : { from: view.from, to: Math.max(view.from + MIN_SELECTION, Math.min(to, view.to + delta)) }
  }

  const grips = $derived<readonly { edge: Edge; t: number; min: number; max: number }[]>([
    { edge: 'head', t: view.from, min: from, max: view.to - MIN_SELECTION },
    { edge: 'tail', t: view.to, min: view.from + MIN_SELECTION, max: to },
  ])

  const chartLabel = $derived(
    `Cumulative pixels painted and rolling pace from ${formatTime(view.from)} to ${formatTime(view.to)}. Use the arrow keys to read values.`,
  )
</script>

<div class="flex flex-col gap-2" bind:clientWidth={width}>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <div class="flex items-center gap-3 text-base-content/70">
      <span class="inline-flex items-center gap-1.5">
        <span
          class="size-2.5 rounded-xs border-t-2"
          style:background="color-mix(in oklab, var(--chart-correct) 35%, transparent)"
          style:border-color="var(--chart-correct)"
        ></span>
        correct
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2.5 rounded-xs bg-error/30"></span>
        painted, mismatched
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-0.5" role="group" aria-label="rolling pace lines">
      <span class="me-1 text-base-content/40">pace</span>
      {#each paceWindows as pace, index (pace.key)}
        {@const enabled = enabledWindows.has(pace.key)}
        <button
          type="button"
          class="btn btn-xs {enabled && pace.usable ? 'btn-soft' : 'btn-ghost'} gap-1.5 px-1.5 tabular-nums"
          aria-pressed={enabled && pace.usable}
          disabled={!pace.usable}
          data-pace-toggle={pace.key}
          title={pace.usable
            ? `Toggle the ${pace.key} rolling pace line`
            : `No retained data is fine enough for the ${pace.key} pace line`}
          onclick={() => toggleWindow(pace.key)}
        >
          <span
            class="rounded-full"
            style:width="10px"
            style:height="{paceWidth(index / (PACE_WINDOWS.length - 1)) + 1}px"
            style:background={paceColor(index / (PACE_WINDOWS.length - 1))}
            aria-hidden="true"
          ></span>
          {pace.key}
        </button>
      {/each}
    </div>

    {#if hasActivity}
      <div class="ms-auto flex items-center gap-0.5" role="group" aria-label="time range">
        {#each presets as preset (preset.key)}
          {@const active = presetActive(preset.seconds)}
          <button
            type="button"
            class="btn btn-xs {active ? 'btn-primary' : 'btn-ghost'} px-1.5 tabular-nums"
            aria-pressed={active}
            data-range-preset={preset.key}
            title="Show {preset.label}"
            onclick={() => (selection = presetWindow(preset.seconds))}
          >
            {preset.key}
          </button>
        {/each}
        <button
          type="button"
          class="btn btn-xs {zoomed ? 'btn-ghost' : 'btn-primary'} px-1.5"
          aria-pressed={!zoomed}
          data-range-preset="all"
          title="Show the whole history"
          onclick={resetWindow}
        >
          all
        </button>
      </div>
    {/if}
  </div>

  {#if hasActivity}
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
        {/each}
        {#if activePaces.length > 0}
          {#each rightScale.ticks as tick (tick)}
            <text
              x={width - pad.right + 8}
              y={yRight(tick) + 3}
              text-anchor="start"
              aria-label={`${formatPixels(tick)} per hour`}
              class="fill-base-content/40 text-[10px] tabular-nums"
              ><title>{formatPixels(tick)} per hour</title>{formatCount(tick)}</text
            >
          {/each}
        {/if}
        <text x={pad.left - 8} y={9} text-anchor="end" class="fill-base-content/40 text-[9px]">px</text>
        {#if activePaces.length > 0}
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

        <path d={bandPath(() => 0, (p) => p.cumCorrect)} fill="var(--chart-correct)" opacity="0.3" />
        <path
          d={bandPath((p) => p.cumCorrect, (p) => p.cumCorrect + p.cumMismatched)}
          class="fill-error"
          opacity="0.25"
        />
        <path
          d={visiblePoints
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yLeft(p.cumCorrect).toFixed(1)}`)
            .join('')}
          fill="none"
          stroke="var(--chart-correct)"
          stroke-width="1.5"
          stroke-linejoin="round"
        />

        {#each activePaces as pace (pace.key)}
          <path
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

        {#if plotDrag !== null}
          <rect
            data-plot-selection
            x={Math.min(x(plotDrag.from), x(plotDrag.to))}
            y={pad.top}
            width={Math.abs(x(plotDrag.to) - x(plotDrag.from))}
            height={plotHeight}
            class="fill-primary/10 stroke-primary/50"
          />
        {/if}

        {#if hover !== null}
          <line
            data-crosshair
            x1={x(hover.t)}
            x2={x(hover.t)}
            y1={pad.top}
            y2={height - pad.bottom}
            class="stroke-base-content/25"
          />
          <circle
            cx={x(hover.t)}
            cy={yLeft(hover.cumCorrect)}
            r="3"
            fill="var(--chart-correct)"
            class="stroke-base-100"
            stroke-width="1.5"
          />
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
        {/if}
      </svg>

      {#if hover !== null}
        <div
          class="pointer-events-none absolute z-10 rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-sm"
          style:top="{pad.top}px"
          style:left={x(hover.t) > width * 0.55 ? null : `${x(hover.t) + 12}px`}
          style:right={x(hover.t) > width * 0.55 ? `${width - x(hover.t) + 12}px` : null}
        >
          <div class="font-medium tabular-nums">
            {formatTime(hover.t)}{#if liveEdge !== null && hover.t === liveEdge.t}
              <span class="ms-1 text-base-content/50">now</span>{/if}
          </div>
          <div class="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5 tabular-nums">
            <span class="size-2 rounded-xs" style:background="var(--chart-correct)"></span>
            <span class="text-base-content/70">correct</span>
            <span class="text-end">{hover.cumCorrect.toLocaleString()}</span>
            <span class="size-2 rounded-xs bg-error/70"></span>
            <span class="text-base-content/70">mismatched</span>
            <span class="text-end">{hover.cumMismatched.toLocaleString()}</span>
            {#each activePaces as pace (pace.key)}
              {@const value = hoverPace(pace.series, hover.t)}
              {#if value !== null}
                <span
                  class="h-0.5 w-2 rounded-full"
                  style:height="{paceWidth(pace.rank)}px"
                  style:background={paceColor(pace.rank)}
                ></span>
                <span class="text-base-content/70">pace {pace.key}</span>
                <span class="text-end">{formatExactCount(value)} px/h</span>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      <div class="sr-only" aria-live="polite">{announce}</div>
    </div>

    <!-- The strip is a pointer gesture surface; its keyboard equivalent is the two grips inside. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="relative touch-none select-none {brushDrag === 'move'
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
        <path d={brushOutline} fill="var(--chart-placed)" opacity="0.35" />
        <rect
          data-brush-window
          x={bx(view.from)}
          y={brushPad.top}
          width={Math.max(0, bx(view.to) - bx(view.from))}
          height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
          class="fill-primary/15 stroke-primary/70 {brushDrag === 'move' ? 'cursor-grabbing' : 'cursor-grab'}"
        />
      </svg>
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
          class="group absolute inset-y-0 flex -translate-x-1/2 cursor-ew-resize items-center justify-center outline-none"
          style:left="{bx(grip.t)}px"
          style:width="{gripHitWidth}px"
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
