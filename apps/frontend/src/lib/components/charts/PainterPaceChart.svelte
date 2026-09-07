<script lang="ts">
  import { type ContributionDay, formatExactCount, formatPixels } from '@caelestis/shared'
  import { untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { Tween } from 'svelte/motion'
  import { fade, type TransitionConfig } from 'svelte/transition'
  import {
    DAY_SECONDS,
    dayStart,
    defaultVisiblePainters,
    PAINTER_METRICS,
    type PainterMetric,
    type PainterSeries,
    painterColour,
    painterLabel,
    painterSeries,
  } from '$lib/components/charts/painter-pace'
  import {
    availableRangePresets,
    axisScale,
    clampWindow,
    clipSeries,
    formatCount,
    nearestSorted,
    snapTime,
    timeTickStep,
    type TimeWindow,
  } from '$lib/components/charts/progress-pace'
  import SlidingTabs from '$lib/components/charts/SlidingTabs.svelte'
  import { persisted } from '$lib/persisted.svelte'

  let {
    days,
    from,
    to,
    coverageFrom,
    live = false,
  }: {
    /** The server's reduced painter-days for the scope. Painters who opted out are not in here. */
    days: readonly ContributionDay[]
    /** When the scope started, in seconds. */
    from: number
    to: number
    /** The earliest time the contribution request covered; days before it were never asked for. */
    coverageFrom: number
    /** The right edge is now: today's level holds out to the edge while painting continues. */
    live?: boolean
  } = $props()

  // ── Series ───────────────────────────────────────────────────────────────────────────────────
  // History before the fetched coverage is unavailable, not zero: the axis starts where the data
  // does and the caption says so, rather than drawing a flat line through days nobody asked for.
  const start = $derived(Math.max(dayStart(from), dayStart(coverageFrom)))
  const unavailableBefore = $derived(dayStart(from) < start ? start : null)
  const series = $derived(painterSeries(days, start, to))
  const dayTimes = $derived(series[0]?.days.map((day) => day.day) ?? [])

  const storedMetric = persisted<PainterMetric>('caelestis:painter-metric', 'placed')
  const metric = $derived<PainterMetric>(
    PAINTER_METRICS.some((candidate) => candidate.key === storedMetric.value)
      ? storedMetric.value
      : 'placed',
  )
  const metricNoun = $derived(
    PAINTER_METRICS.find((candidate) => candidate.key === metric)?.noun ?? metric,
  )

  // ── Selection ────────────────────────────────────────────────────────────────────────────────
  // The leading painters draw by default. A legend toggle records an override for that painter
  // only, so the default set can shift with the data without undoing anyone's choices.
  const defaults = $derived(defaultVisiblePainters(series))
  let overrides = $state<Record<number, boolean>>({})
  const isVisible = (painter: PainterSeries): boolean =>
    overrides[painter.wplaceUserId] ?? defaults.has(painter.wplaceUserId)
  const togglePainter = (painter: PainterSeries): void => {
    overrides = { ...overrides, [painter.wplaceUserId]: !isVisible(painter) }
  }
  const visible = $derived(series.filter(isVisible))

  let legendExpanded = $state(false)
  const legendPainters = $derived(
    legendExpanded
      ? series
      : series.filter((painter) => defaults.has(painter.wplaceUserId) || isVisible(painter)),
  )
  const legendHidden = $derived(series.length - legendPainters.length)

  // ── Time window ──────────────────────────────────────────────────────────────────────────────
  // `null` shows the whole fetched range. Presets stay attached to a moving live edge, while
  // pointer selections keep their absolute timestamps across a re-fetch.
  const resolution = DAY_SECONDS
  let selection = $state<TimeWindow | null>(null)
  let relativePreset = $state<number | null>(null)
  const span = $derived(to - start)
  const MIN_SELECTION = $derived(Math.min(span, resolution * 3))
  const view = $derived.by<TimeWindow>(() => {
    if (relativePreset !== null) {
      return clampWindow({ from: to - relativePreset, to }, start, to, MIN_SELECTION)
    }
    return selection === null ? { from: start, to } : clampWindow(selection, start, to, MIN_SELECTION)
  })
  const zoomed = $derived(view.from > start || view.to < to)
  const resetWindow = (): void => {
    relativePreset = null
    selection = null
  }
  const selectWindow = (window: TimeWindow): void => {
    relativePreset = null
    selection = window
  }
  const presets = $derived(availableRangePresets(span, MIN_SELECTION))
  const activePreset = $derived(
    zoomed ? (presets.find((preset) => preset.seconds === relativePreset)?.key ?? null) : 'all',
  )
  const rangeOptions = $derived([
    ...presets.map((preset) => ({ key: preset.key, label: preset.key, title: `Show ${preset.label}` })),
    { key: 'all', label: 'all', title: 'Show the whole history' },
  ])
  const selectRange = (key: string): void => {
    const preset = presets.find((candidate) => candidate.key === key)
    if (preset === undefined) resetWindow()
    else {
      relativePreset = preset.seconds
      selection = null
    }
  }

  interface RatePoint {
    readonly t: number
    readonly v: number
  }
  const lerpRate = (a: RatePoint, b: RatePoint, fraction: number): RatePoint => ({
    t: a.t + (b.t - a.t) * fraction,
    v: a.v + (b.v - a.v) * fraction,
  })

  /** A painter's daily rate for the chosen metric, over the whole fetched range. */
  const fullSeries = (painter: PainterSeries): RatePoint[] =>
    painter.days.map((day) => ({ t: day.day, v: day[metric] }))

  /** The points inside a range, holding today's level out to the right edge. */
  const windowSeries = (points: readonly RatePoint[], range: TimeWindow): RatePoint[] => {
    const clipped = clipSeries(points, range.from, range.to, lerpRate)
    const last = clipped[clipped.length - 1]
    if (last !== undefined && last.t < range.to) clipped.push({ t: range.to, v: last.v })
    return clipped
  }

  const painterLines = $derived(
    visible.map((painter) => ({ painter, fullSeries: fullSeries(painter) })),
  )

  // ── Geometry ─────────────────────────────────────────────────────────────────────────────────
  let width = $state(640)
  const height = 240
  const pad = { top: 18, right: 16, bottom: 22, left: 48 }
  const plotWidth = $derived(Math.max(1, width - pad.left - pad.right))
  const plotHeight = height - pad.top - pad.bottom

  // The axis top comes from the target window, so a zoom re-fits to where it is going.
  const scale = $derived(
    axisScale(
      Math.max(
        0,
        ...painterLines.flatMap((line) =>
          clipSeries(line.fullSeries, view.from, view.to, lerpRate).map((point) => point.v),
        ),
      ),
      4,
      1,
    ),
  )

  // ── Refit ────────────────────────────────────────────────────────────────────────────────────
  // The drawn domain and axis top chase their targets, so a preset, a plot-drag zoom, a metric
  // switch, or a toggled painter re-fits the plot instead of snapping it. Reduced motion turns
  // every tween and transition into a cut.
  const REFIT_MS = 400
  const reduceMotion =
    typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)')
  const motion = (ms: number): number => (reduceMotion?.matches ? 0 : ms)
  const shownWindow = new Tween(
    untrack(() => ({ from: view.from, to: view.to })),
    { duration: REFIT_MS, easing: cubicOut },
  )
  const shownMax = new Tween(
    untrack(() => scale.max),
    { duration: REFIT_MS, easing: cubicOut },
  )
  $effect(() => {
    void shownWindow.set({ from: view.from, to: view.to }, { duration: motion(REFIT_MS) })
  })
  $effect(() => {
    void shownMax.set(scale.max, { duration: motion(REFIT_MS) })
  })
  const shownView = $derived<TimeWindow>({
    from: shownWindow.current.from,
    to: shownWindow.current.to,
  })

  const drawnLines = $derived(
    painterLines.map((line) => ({ ...line, series: windowSeries(line.fullSeries, shownView) })),
  )

  const x = $derived(
    (t: number) =>
      pad.left + ((t - shownView.from) / Math.max(1, shownView.to - shownView.from)) * plotWidth,
  )
  const y = $derived((v: number) => height - pad.bottom - (v / shownMax.current) * plotHeight)
  const timeIn = (range: TimeWindow, clientX: number, left: number): number =>
    range.from + ((clientX - left - pad.left) / plotWidth) * (range.to - range.from)

  const linePath = (points: readonly RatePoint[]): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')

  const tickStep = $derived(timeTickStep(shownView.to - shownView.from, plotWidth))
  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    for (let t = Math.ceil(shownView.from / tickStep) * tickStep; t < shownView.to; t += tickStep) {
      ticks.push(t)
    }
    return ticks
  })

  const formatDay = (t: number): string =>
    new Date(t * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })

  const formatTick = (t: number): string => {
    const crossesYear =
      new Date(shownView.from * 1_000).getUTCFullYear() !==
      new Date((shownView.to - 1) * 1_000).getUTCFullYear()
    return new Date(t * 1000).toLocaleString(undefined, {
      ...(crossesYear ? { year: 'numeric' } : {}),
      month: 'short',
      day: 'numeric',
      ...(tickStep < DAY_SECONDS ? { hour: '2-digit', minute: '2-digit' } : {}),
      timeZone: 'UTC',
    })
  }

  // ── Hover and keyboard ───────────────────────────────────────────────────────────────────────
  // The crosshair snaps to UTC day starts inside the window. Arrow keys walk the days, up and
  // down walk the drawn painters, and the live region reads out what the walk landed on.
  const hoverSnapTimes = $derived(
    dayTimes.filter((t) => t >= shownView.from - 1 && t <= shownView.to),
  )
  let hoverTime = $state<number | null>(null)
  let focusPainter = $state<number | null>(null)
  let announce = $state('')

  const isToday = (t: number): boolean => live && view.to === to && t === dayStart(to - 1)

  const valueAt = (painter: PainterSeries, t: number): number | null =>
    painter.days.find((day) => day.day === t)?.[metric] ?? null

  /** Drawn painters at a day, highest value first, so the tooltip reads like a leaderboard. */
  const hoverRows = $derived.by(() => {
    const t = hoverTime
    if (t === null) return []
    return visible
      .flatMap((painter) => {
        const value = valueAt(painter, t)
        return value === null ? [] : [{ painter, value }]
      })
      .sort((a, b) => b.value - a.value)
  })
  const focusedRow = $derived(
    hoverRows.find((row) => row.painter.wplaceUserId === focusPainter) ?? null,
  )

  const hoverAt = (t: number | null): void => {
    hoverTime = t
  }
  const hoverPointer = (clientX: number, left: number): void =>
    hoverAt(nearestSorted(hoverSnapTimes, timeIn(shownView, clientX, left)))

  const dayLabel = (t: number): string => `${formatDay(t)}${isToday(t) ? ' (today so far)' : ''}`
  const rateLabel = (value: number): string => `${formatExactCount(value)} ${metricNoun} per day`

  const hoverSummary = (): string => {
    const t = hoverTime
    if (t === null) return ''
    if (focusedRow !== null) {
      return `${painterLabel(focusedRow.painter)}, ${dayLabel(t)}, ${rateLabel(focusedRow.value)}`
    }
    if (hoverRows.length === 0) return `${dayLabel(t)}, no painters shown`
    return `${dayLabel(t)}, ${hoverRows
      .map((row) => `${painterLabel(row.painter)} ${rateLabel(row.value)}`)
      .join(', ')}`
  }

  const onPlotKey = (event: KeyboardEvent): void => {
    const times = hoverSnapTimes
    if (times.length === 0) return
    const index = hoverTime === null ? -1 : times.indexOf(hoverTime)
    const painterIndex = visible.findIndex((painter) => painter.wplaceUserId === focusPainter)
    let next: number | undefined = hoverTime ?? undefined
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
      case 'ArrowDown':
        if (visible.length === 0) return
        focusPainter =
          visible[(painterIndex + 1) % visible.length]?.wplaceUserId ?? null
        next ??= times[times.length - 1]
        break
      case 'ArrowUp':
        if (visible.length === 0) return
        focusPainter =
          painterIndex <= 0
            ? null
            : (visible[painterIndex - 1]?.wplaceUserId ?? null)
        next ??= times[times.length - 1]
        break
      case 'Escape':
        if (hoverTime !== null || focusPainter !== null) {
          hoverTime = null
          focusPainter = null
        } else if (zoomed) resetWindow()
        else return
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    if (next === undefined) return
    hoverAt(next)
    announce = hoverSummary()
  }

  /** The hover card pops from its anchored corner, on the transitions.dev tooltip timings. */
  const pop = (_node: Element, { duration }: { duration: number }): TransitionConfig => ({
    duration,
    easing: cubicOut,
    css: (t) => `opacity:${t};transform:scale(${0.98 + 0.02 * t})`,
  })

  // ── Drag on the plot to zoom ─────────────────────────────────────────────────────────────────
  // Listeners live on `window` for the length of a drag, so the gesture keeps working when the
  // pointer leaves the plot or even the page. They attach synchronously: the next pointer event
  // may arrive before any microtask runs.
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
              from: snapTime(Math.min(drag.from, drag.to), resolution, start, to),
              to: snapTime(Math.max(drag.from, drag.to), resolution, start, to),
            },
            start,
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
      if (!inside) hoverTime = null
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

  const chartLabel = $derived(
    `Daily ${metricNoun} per painter from ${formatDay(view.from)} to ${formatDay(view.to - 1)}, ${visible.length} of ${series.length} painters shown. Use the arrow keys to read values.`,
  )
  const strokeWidth = (painter: PainterSeries): number =>
    painter.wplaceUserId === focusPainter ? 2.5 : 1.5
  const strokeOpacity = (painter: PainterSeries): number =>
    focusPainter === null || painter.wplaceUserId === focusPainter ? 1 : 0.3
</script>

<div class="flex flex-col gap-3" bind:clientWidth={width}>
  <div class="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
    <div class="flex items-center gap-2">
      <span class="text-base-content/65">metric</span>
      <SlidingTabs
        options={PAINTER_METRICS.map((candidate) => ({
          key: candidate.key,
          label: candidate.label,
          title: `Show ${candidate.noun} per day`,
        }))}
        value={metric}
        label="pace metric"
        name="painter-metric"
        onselect={(key) => {
          storedMetric.value = key as PainterMetric
        }}
      />
      <span class="text-base-content/50">px/day</span>
    </div>

    {#if series.length > 0}
      <div class="ms-auto flex items-center gap-2">
        <span class="text-base-content/65">range</span>
        <SlidingTabs
          options={rangeOptions}
          value={activePreset}
          label="time range"
          name="range-preset"
          onselect={selectRange}
        />
      </div>
    {/if}
  </div>

  {#if series.length === 0}
    <div
      class="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-base-300 px-4 text-center text-sm text-base-content/50"
    >
      No shared painter activity in this range yet. Painters appear here when their userscript
      reports contributions.
    </div>
  {:else}
    <div class="relative">
      <!-- The image is focusable so keyboard users can walk the days and painters; the live region
           below reads each one out. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <svg
        {width}
        {height}
        role="img"
        tabindex="0"
        aria-label={chartLabel}
        class="block touch-pan-y cursor-crosshair rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        onpointermove={(event) => {
          if (plotDrag === null) {
            hoverPointer(event.clientX, event.currentTarget.getBoundingClientRect().left)
          }
        }}
        onpointerleave={() => {
          if (plotDrag === null) hoverTime = null
        }}
        onpointerdown={onPlotPointerDown}
        ondblclick={resetWindow}
        onkeydown={onPlotKey}
      >
        {#each scale.ticks as tick (tick)}
          {#if y(tick) >= pad.top}
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              class="stroke-base-content/10"
            />
            <text
              x={pad.left - 8}
              y={y(tick) + 3}
              text-anchor="end"
              aria-label={`${formatPixels(tick)} per day`}
              class="fill-base-content/50 text-[10px] tabular-nums"
              ><title>{formatPixels(tick)} per day</title>{formatCount(tick)}</text
            >
          {/if}
        {/each}
        <text x={pad.left - 8} y={9} text-anchor="end" class="fill-base-content/40 text-[9px]"
          >px/day</text
        >
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
          {#each drawnLines as line (line.painter.wplaceUserId)}
            <path
              in:fade={{ duration: motion(250) }}
              out:fade={{ duration: motion(150) }}
              data-painter-line={line.painter.wplaceUserId}
              d={linePath(line.series)}
              fill="none"
              stroke={painterColour(line.painter.wplaceUserId)}
              stroke-width={strokeWidth(line.painter)}
              stroke-opacity={strokeOpacity(line.painter)}
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/each}
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

        {#if hoverTime !== null}
          <g in:fade={{ duration: motion(150) }} out:fade={{ duration: motion(100) }}>
            <line
              data-crosshair
              x1={x(hoverTime)}
              x2={x(hoverTime)}
              y1={pad.top}
              y2={height - pad.bottom}
              class="stroke-base-content/25"
            />
            {#each hoverRows as row (row.painter.wplaceUserId)}
              <circle
                cx={x(hoverTime)}
                cy={y(row.value)}
                r={row.painter.wplaceUserId === focusPainter ? 4 : 3}
                fill={painterColour(row.painter.wplaceUserId)}
                class="stroke-base-100"
                stroke-width="1.5"
              />
            {/each}
          </g>
        {/if}
      </svg>

      {#if hoverTime !== null}
        <div
          data-painter-tooltip
          class="pointer-events-none absolute z-10 max-w-[min(20rem,calc(100%-1rem))] rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-sm"
          in:pop={{ duration: motion(150) }}
          out:pop={{ duration: motion(100) }}
          style:transform-origin={x(hoverTime) > width * 0.55 ? '100% 0' : '0 0'}
          style:top="{pad.top}px"
          style:left={x(hoverTime) > width * 0.55 ? null : `${x(hoverTime) + 12}px`}
          style:right={x(hoverTime) > width * 0.55 ? `${width - x(hoverTime) + 12}px` : null}
        >
          <div class="font-medium tabular-nums">
            {formatDay(hoverTime)}{#if isToday(hoverTime)}
              <span class="ms-1 text-base-content/50">today so far</span>{/if}
          </div>
          {#if hoverRows.length === 0}
            <div class="mt-1 text-base-content/50">No painters shown</div>
          {:else}
            <div class="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5 tabular-nums">
              {#each hoverRows as row (row.painter.wplaceUserId)}
                {@const focused = row.painter.wplaceUserId === focusPainter}
                <span
                  class="h-0.5 w-2.5 rounded-full"
                  style:background={painterColour(row.painter.wplaceUserId)}
                ></span>
                <span class="truncate {focused ? 'font-semibold' : 'text-base-content/70'}"
                  >{painterLabel(row.painter)}</span
                >
                <span class="text-end {focused ? 'font-semibold' : ''}"
                  >{formatExactCount(row.value)} px/day</span
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="sr-only" aria-live="polite">{announce}</div>
    </div>

    <div class="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="painters">
      {#each legendPainters as painter (painter.wplaceUserId)}
        {@const shown = isVisible(painter)}
        <button
          type="button"
          class="btn btn-xs {shown ? 'btn-soft' : 'btn-ghost'} max-w-48 gap-1.5"
          aria-pressed={shown}
          data-painter-toggle={painter.wplaceUserId}
          title={`${shown ? 'Hide' : 'Show'} ${painterLabel(painter)}`}
          onclick={() => togglePainter(painter)}
          onpointerenter={() => {
            if (shown) focusPainter = painter.wplaceUserId
          }}
          onpointerleave={() => {
            if (focusPainter === painter.wplaceUserId) focusPainter = null
          }}
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            style:background={painterColour(painter.wplaceUserId)}
            style:opacity={shown ? 1 : 0.35}
            aria-hidden="true"
          ></span>
          <span class="truncate">{painterLabel(painter)}</span>
        </button>
      {/each}
      {#if legendHidden > 0 || legendExpanded}
        <button
          type="button"
          class="btn btn-xs btn-ghost text-base-content/65"
          data-legend-more
          aria-expanded={legendExpanded}
          onclick={() => {
            legendExpanded = !legendExpanded
          }}
        >
          {legendExpanded ? 'fewer' : `+${legendHidden} more`}
        </button>
      {/if}
    </div>
  {/if}

  {#if unavailableBefore !== null}
    <p class="text-xs text-base-content/50" data-unavailable-before={unavailableBefore}>
      Painter history before {formatDay(unavailableBefore)} is no longer available, so the chart
      starts there.
    </p>
  {/if}
</div>
