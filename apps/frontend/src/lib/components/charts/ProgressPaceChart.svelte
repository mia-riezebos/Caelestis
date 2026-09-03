<script lang="ts">
  import type { HistoryBucket } from '@caelestis/shared'
  import { persisted } from '$lib/persisted.svelte'
  import {
    PACE_WINDOWS,
    type PaceHistorySource,
    type PacePoint,
    rollingPaceSeries,
    timeTickStep,
  } from '$lib/components/charts/progress-pace'

  let {
    buckets,
    paceHistories = [],
    resolution,
    from,
    to,
    anchorCorrect,
    anchorMismatched,
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

  // ── Brush ────────────────────────────────────────────────────────────────────────────────────
  // The strip under the chart holds the full fetched range; the selection windows the chart above.
  // Pace and cumulatives are still derived from the full data, so a window's left edge shows real
  // values, not a restart from zero.
  let selFrom = $state(0)
  let selTo = $state(0)

  $effect(() => {
    selFrom = from
    selTo = to
  })

  const MIN_SELECTION = $derived(resolution * 6)
  const zoomed = $derived(selFrom > from || selTo < to)

  const visiblePoints = $derived(points.filter((p) => p.t >= selFrom && p.t <= selTo))

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

  const paceWindows = $derived(
    PACE_WINDOWS.map((window) => {
      const retained = paceHistories.find((source) => source.window === window.key)
      const source = windowUsable(window.seconds, resolution)
        ? { points, resolution }
        : retained?.history.resolution !== undefined &&
            windowUsable(window.seconds, retained.history.resolution)
          ? { points: retainedPacePoints(retained), resolution: retained.history.resolution }
          : null
      const fullSeries =
        source === null
          ? []
          : rollingPaceSeries(source.points, source.resolution, window.seconds)
      const series = fullSeries.filter((point) => point.t >= selFrom && point.t <= selTo)
      return { ...window, usable: fullSeries.length > 0, fullSeries, series }
    }),
  )

  const activePaces = $derived(
    paceWindows.filter((w) => enabledWindows.has(w.key) && w.usable).map(
      (w, _, all) => ({
        ...w,
        rank:
          PACE_WINDOWS.findIndex((x) => x.key === w.key) /
          Math.max(1, PACE_WINDOWS.length - 1),
        count: all.length,
      }),
    ),
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

  let width = $state(640)
  const height = 240
  const pad = { top: 12, right: 48, bottom: 22, left: 48 }

  const nice = (raw: number): number => {
    const safe = Math.max(1, raw)
    const magnitude = 10 ** Math.floor(Math.log10(safe))
    return Math.ceil(safe / magnitude) * magnitude
  }
  const yMaxLeft = $derived(
    nice(Math.max(1, ...visiblePoints.map((p) => p.cumCorrect + p.cumMismatched))),
  )
  const yMaxRight = $derived(
    nice(Math.max(1, ...activePaces.flatMap((p) => p.series.map((s) => s.v)))),
  )

  const x = $derived(
    (t: number) => pad.left + ((t - selFrom) / (selTo - selFrom)) * (width - pad.left - pad.right),
  )
  const yLeft = $derived(
    (v: number) => height - pad.bottom - (v / yMaxLeft) * (height - pad.top - pad.bottom),
  )
  const yRight = $derived(
    (v: number) => height - pad.bottom - (v / yMaxRight) * (height - pad.top - pad.bottom),
  )

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

  const yTicks = $derived([0.25, 0.5, 0.75, 1])
  const DAY_SECONDS = 86_400
  const tickStep = $derived(timeTickStep(selTo - selFrom, width - pad.left - pad.right))

  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    for (let t = Math.ceil(selFrom / tickStep) * tickStep; t < selTo; t += tickStep) {
      ticks.push(t)
    }
    return ticks
  })

  const formatTick = (t: number): string => {
    const date = new Date(t * 1000)
    const rangeStart = new Date(selFrom * 1_000)
    const rangeEnd = new Date((selTo - 1) * 1_000)
    const crossesDay =
      rangeStart.getFullYear() !== rangeEnd.getFullYear() ||
      rangeStart.getMonth() !== rangeEnd.getMonth() ||
      rangeStart.getDate() !== rangeEnd.getDate()
    if (!crossesDay) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    const crossesYear = rangeStart.getFullYear() !== rangeEnd.getFullYear()
    return date.toLocaleString(undefined, {
      ...(crossesYear ? { year: 'numeric' } : {}),
      month: 'short',
      day: 'numeric',
      ...(tickStep < DAY_SECONDS ? { hour: '2-digit', minute: '2-digit' } : {}),
    })
  }

  const formatCount = (v: number): string =>
    v >= 1000 ? `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : String(Math.round(v))

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

  const onPointerMove = (event: PointerEvent): void => {
    if (hoverSnapTimes.length === 0) return
    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
    // Map time through the plot area and exclude the axis gutters.
    const plotX = event.clientX - bounds.left - pad.left
    const t = selFrom + (plotX / (width - pad.left - pad.right)) * (selTo - selFrom)
    let nearest = hoverSnapTimes[0]
    for (const pointTime of hoverSnapTimes) {
      if (nearest === undefined || Math.abs(pointTime - t) < Math.abs(nearest - t)) nearest = pointTime
    }
    if (nearest === undefined) return
    const cumCorrect = interpolateValue(visiblePoints, nearest, (point) => point.cumCorrect, true)
    const cumMismatched = interpolateValue(visiblePoints, nearest, (point) => point.cumMismatched, true)
    if (cumCorrect === null || cumMismatched === null) return
    hover = {
      t: nearest,
      cumCorrect: Math.round(cumCorrect),
      cumMismatched: Math.round(cumMismatched),
    }
  }

  // ── Brush interactions ───────────────────────────────────────────────────────────────────────
  const BRUSH_HEIGHT = 44
  const brushPad = { top: 4, bottom: 4 }

  const bx = $derived(
    (t: number) => pad.left + ((t - from) / (to - from)) * (width - pad.left - pad.right),
  )
  const brushT = (clientX: number, bounds: DOMRect): number => {
    const fraction = (clientX - bounds.left - pad.left) / (width - pad.left - pad.right)
    const t = from + fraction * (to - from)
    return Math.round(Math.min(to, Math.max(from, t)) / resolution) * resolution
  }

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

  type BrushDrag =
    | { kind: 'head' }
    | { kind: 'tail' }
    | { kind: 'move'; grabOffset: number }
    | { kind: 'new'; anchor: number }
  let brushDrag: BrushDrag | null = null

  const HANDLE_GRAB_PX = 8

  const onBrushDown = (event: PointerEvent): void => {
    const svg = event.currentTarget as SVGSVGElement
    svg.setPointerCapture(event.pointerId)
    const bounds = svg.getBoundingClientRect()
    const px = event.clientX - bounds.left
    const t = brushT(event.clientX, bounds)
    if (Math.abs(px - bx(selFrom)) <= HANDLE_GRAB_PX) brushDrag = { kind: 'head' }
    else if (Math.abs(px - bx(selTo)) <= HANDLE_GRAB_PX) brushDrag = { kind: 'tail' }
    else if (t > selFrom && t < selTo) brushDrag = { kind: 'move', grabOffset: t - selFrom }
    else brushDrag = { kind: 'new', anchor: t }
  }

  const onBrushMove = (event: PointerEvent): void => {
    if (brushDrag === null) return
    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
    const t = brushT(event.clientX, bounds)
    switch (brushDrag.kind) {
      case 'head':
        selFrom = Math.min(t, selTo - MIN_SELECTION)
        break
      case 'tail':
        selTo = Math.max(t, selFrom + MIN_SELECTION)
        break
      case 'move': {
        const span = selTo - selFrom
        selFrom = Math.min(to - span, Math.max(from, t - brushDrag.grabOffset))
        selTo = selFrom + span
        break
      }
      case 'new': {
        const lo = Math.min(brushDrag.anchor, t)
        const hi = Math.max(brushDrag.anchor, t)
        if (hi - lo >= MIN_SELECTION) {
          selFrom = lo
          selTo = hi
        }
        break
      }
    }
    selFrom = Math.max(from, selFrom)
    selTo = Math.min(to, selTo)
  }

  const onBrushUp = (): void => {
    brushDrag = null
  }

  const resetBrush = (): void => {
    selFrom = from
    selTo = to
  }

  const hoverPace = (series: readonly { t: number; v: number }[], t: number): number | null =>
    interpolateValue(series, t, (point) => point.v)
</script>

<div class="relative" bind:clientWidth={width}>
  <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-base-content/70">
    <span class="inline-flex items-center gap-1.5">
      <span class="size-2.5 rounded-xs" style:background="var(--chart-correct)"></span> correct
    </span>
    <span class="inline-flex items-center gap-1.5">
      <span class="size-2.5 rounded-xs bg-error/60"></span> painted, mismatched
    </span>
    <span class="ms-2 text-base-content/40">pace</span>
    {#each paceWindows as window, index (window.key)}
      {@const usable = window.usable}
      <button
        class="inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 transition-colors
          {usable ? 'hover:bg-base-200' : 'cursor-not-allowed opacity-35'}
          {enabledWindows.has(window.key) && usable ? 'bg-base-200' : ''}"
        disabled={!usable}
        title={usable
          ? `toggle the ${window.key} rolling pace line`
          : `no retained data is fine enough for the ${window.key} pace line`}
        onclick={() => toggleWindow(window.key)}
      >
        <span
          class="rounded-full"
          style:width="10px"
          style:height="{paceWidth(index / (PACE_WINDOWS.length - 1)) + 1}px"
          style:background={paceColor(index / (PACE_WINDOWS.length - 1))}
        ></span>
        {window.key}
      </button>
    {/each}
  </div>

  {#if hasActivity}
    <svg
      {width}
      {height}
      role="img"
      aria-label="cumulative pixels painted and rolling pace over the window"
      onpointermove={onPointerMove}
      onpointerleave={() => (hover = null)}
    >
      {#each yTicks as fraction (fraction)}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={yLeft(fraction * yMaxLeft)}
          y2={yLeft(fraction * yMaxLeft)}
          class="stroke-base-content/10"
        />
        {#if fraction < 1}
          <text
            x={pad.left - 6}
            y={yLeft(fraction * yMaxLeft) + 3}
            text-anchor="end"
            class="fill-base-content/50 text-[10px] tabular-nums">{formatCount(fraction * yMaxLeft)}</text
          >
          {#if activePaces.length > 0}
            <text
              x={width - pad.right + 6}
              y={yRight(fraction * yMaxRight) + 3}
              text-anchor="start"
              class="fill-base-content/40 text-[10px] tabular-nums"
              >{formatCount(fraction * yMaxRight)}</text
            >
          {/if}
        {/if}
      {/each}
      <text x={pad.left - 6} y={pad.top - 2} text-anchor="end" class="fill-base-content/40 text-[9px]">px</text>
      {#if activePaces.length > 0}
        <text x={width - pad.right + 6} y={pad.top - 2} text-anchor="start" class="fill-base-content/40 text-[9px]">px/h</text>
      {/if}
      {#each xTicks as tick (tick)}
        <text
          data-axis="time"
          x={x(tick)}
          y={height - 6}
          text-anchor="middle"
          class="fill-base-content/50 text-[10px]"
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

      {#if hover !== null}
        <line
          x1={x(hover.t)}
          x2={x(hover.t)}
          y1={pad.top}
          y2={height - pad.bottom}
          class="stroke-base-content/25"
        />
      {/if}
    </svg>

    <!-- The brush: the full fetched range in miniature; drag the head or tail grip to window the
         chart, drag the middle to slide the window, drag empty track to draw a fresh one. -->
    <div class="mt-1 flex items-center gap-2">
      <svg
        {width}
        height={BRUSH_HEIGHT}
        class="flex-1 touch-none"
        role="slider"
        aria-label="time window — drag the edges to zoom the chart"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={selFrom}
        tabindex="-1"
        onpointerdown={onBrushDown}
        onpointermove={onBrushMove}
        onpointerup={onBrushUp}
        onpointercancel={onBrushUp}
        ondblclick={resetBrush}
      >
        <rect
          x={pad.left}
          y={brushPad.top}
          width={width - pad.left - pad.right}
          height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
          rx="4"
          class="fill-base-200"
        />
        <path d={brushOutline} fill="var(--chart-placed)" opacity="0.35" />
        <rect
          x={bx(selFrom)}
          y={brushPad.top}
          width={Math.max(0, bx(selTo) - bx(selFrom))}
          height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
          class="cursor-grab fill-primary/20 stroke-primary/60"
        />
        {#each [selFrom, selTo] as edge, i (i)}
          <g class="cursor-ew-resize">
            <rect
              x={bx(edge) - HANDLE_GRAB_PX}
              y={brushPad.top}
              width={HANDLE_GRAB_PX * 2}
              height={BRUSH_HEIGHT - brushPad.top - brushPad.bottom}
              fill="transparent"
            />
            <rect
              x={bx(edge) - 2.5}
              y={BRUSH_HEIGHT / 2 - 9}
              width="5"
              height="18"
              rx="2.5"
              class="fill-primary stroke-base-100"
            />
          </g>
        {/each}
      </svg>
      {#if zoomed}
        <button class="btn btn-ghost btn-xs shrink-0" onclick={resetBrush}>reset</button>
      {/if}
    </div>

    {#if hover !== null}
      <div
        class="pointer-events-none absolute z-10 rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-sm"
        style:left="{Math.min(x(hover.t) + 10, width - 150)}px"
        style:top="24px"
      >
        <div class="font-medium">
          {new Date(hover.t * 1000).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
        <div class="mt-0.5 tabular-nums">correct {hover.cumCorrect.toLocaleString()} px</div>
        <div class="tabular-nums">mismatched {hover.cumMismatched.toLocaleString()} px</div>
        {#each activePaces as pace (pace.key)}
          {@const value = hoverPace(pace.series, hover.t)}
          {#if value !== null}
            <div class="tabular-nums text-base-content/70">
              pace {pace.key} · {formatCount(value)} px/h
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  {:else}
    <div
      class="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/50"
    >
      No paint activity reported in this window.
    </div>
  {/if}
</div>
