<script lang="ts">
  import type { HistoryBucket } from '@caelestis/shared'

  let {
    buckets,
    resolution,
    from,
    to,
  }: {
    buckets: readonly HistoryBucket[]
    /** Bucket width in seconds; buckets are summed across templates per bucket start. */
    resolution: number
    from: number
    to: number
  } = $props()

  /**
   * The chart the telemetry issue settled on: one delta fetch, everything else derived here.
   * Stacked cumulative areas — correct under placed-but-mismatched — carry "how many pixels
   * painted"; rolling pace windows `pace_W(t) = (cum(t) − cum(t−W)) / W` ride the right axis.
   * Window size is an ordered dimension: one hue, light→dark and thin→thick, never seven hues.
   */
  const WINDOWS = [
    { key: '30m', seconds: 1_800 },
    { key: '1h', seconds: 3_600 },
    { key: '2h', seconds: 7_200 },
    { key: '3h', seconds: 10_800 },
    { key: '6h', seconds: 21_600 },
    { key: '12h', seconds: 43_200 },
    { key: '1d', seconds: 86_400 },
  ] as const

  let enabledWindows = $state<Set<string>>(new Set(['1h', '6h']))
  const toggleWindow = (key: string): void => {
    const next = new Set(enabledWindows)
    if (!next.delete(key)) next.add(key)
    enabledWindows = next
  }

  /** A window under 2× the tier's resolution has too few samples to mean anything — grey it out. */
  const windowUsable = (seconds: number): boolean => seconds >= 2 * resolution

  interface Point {
    t: number
    placed: number
    correct: number
    cumCorrect: number
    cumMismatched: number
    cumPlaced: number
  }

  const points = $derived.by<Point[]>(() => {
    const byStart = new Map<number, { placed: number; correct: number }>()
    for (const bucket of buckets) {
      const entry = byStart.get(bucket.bucketStart) ?? { placed: 0, correct: 0 }
      entry.placed += bucket.placed
      entry.correct += bucket.correct
      byStart.set(bucket.bucketStart, entry)
    }
    const filled: Point[] = []
    let cumCorrect = 0
    let cumPlaced = 0
    const first = Math.ceil(from / resolution) * resolution
    for (let t = first; t < to; t += resolution) {
      const delta = byStart.get(t) ?? { placed: 0, correct: 0 }
      cumCorrect += delta.correct
      cumPlaced += delta.placed
      filled.push({
        t,
        placed: delta.placed,
        correct: delta.correct,
        cumCorrect,
        cumMismatched: cumPlaced - cumCorrect,
        cumPlaced,
      })
    }
    return filled
  })

  const hasActivity = $derived(points.some((p) => p.placed > 0))

  /** px/h at each point for one window, clipped where the window is not fully covered. */
  const paceSeries = (windowSeconds: number): { t: number; v: number }[] => {
    const series: { t: number; v: number }[] = []
    const steps = Math.round(windowSeconds / resolution)
    for (let i = steps; i < points.length; i++) {
      const now = points[i]
      const before = points[i - steps]
      if (now === undefined || before === undefined) continue
      series.push({ t: now.t, v: ((now.cumPlaced - before.cumPlaced) / windowSeconds) * 3_600 })
    }
    return series
  }

  const activePaces = $derived(
    WINDOWS.filter((w) => enabledWindows.has(w.key) && windowUsable(w.seconds)).map(
      (w, _, all) => ({
        ...w,
        rank: WINDOWS.findIndex((x) => x.key === w.key) / Math.max(1, WINDOWS.length - 1),
        series: paceSeries(w.seconds),
        count: all.length,
      }),
    ),
  )

  /** Ordered ramp: mix the series blue toward the surface — faint for short windows, full for long. */
  const paceColor = (rank: number): string =>
    `color-mix(in oklab, var(--chart-placed) ${Math.round(35 + rank * 65)}%, var(--color-base-100))`
  const paceWidth = (rank: number): number => 1 + rank * 1.5

  let width = $state(640)
  const height = 240
  const pad = { top: 12, right: 48, bottom: 22, left: 48 }

  const nice = (raw: number): number => {
    const safe = Math.max(1, raw)
    const magnitude = 10 ** Math.floor(Math.log10(safe))
    return Math.ceil(safe / magnitude) * magnitude
  }
  const yMaxLeft = $derived(nice(Math.max(1, ...points.map((p) => p.cumPlaced))))
  const yMaxRight = $derived(
    nice(Math.max(1, ...activePaces.flatMap((p) => p.series.map((s) => s.v)))),
  )

  const x = $derived(
    (t: number) => pad.left + ((t - from) / (to - from)) * (width - pad.left - pad.right),
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
    if (points.length === 0) return ''
    const top = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yLeft(upper(p)).toFixed(1)}`)
      .join('')
    const bottom = [...points]
      .reverse()
      .map((p) => `L${x(p.t).toFixed(1)},${yLeft(lower(p)).toFixed(1)}`)
      .join('')
    return `${top}${bottom}Z`
  }

  const yTicks = $derived([0.25, 0.5, 0.75, 1])

  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    const span = to - from
    const step = span > 86_400 * 3 ? 86_400 : span > 86_400 ? 21_600 : 3_600 * 4
    for (let t = Math.ceil(from / step) * step; t < to; t += step) ticks.push(t)
    return ticks
  })

  const formatTick = (t: number): string => {
    const date = new Date(t * 1000)
    return to - from > 86_400 * 3
      ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  const formatCount = (v: number): string =>
    v >= 1000 ? `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : String(Math.round(v))

  let hover = $state<Point | null>(null)

  const onPointerMove = (event: PointerEvent): void => {
    if (points.length === 0) return
    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
    // Map through the plot area, not the whole svg — the axis gutters are not time.
    const plotX = event.clientX - bounds.left - pad.left
    const t = from + (plotX / (width - pad.left - pad.right)) * (to - from)
    let nearest = points[0]
    for (const point of points) {
      if (nearest === undefined || Math.abs(point.t - t) < Math.abs(nearest.t - t)) nearest = point
    }
    hover = nearest ?? null
  }

  const hoverPace = (windowSeconds: number, t: number): number | null => {
    const steps = Math.round(windowSeconds / resolution)
    const index = points.findIndex((p) => p.t === t)
    if (index < steps) return null
    const now = points[index]
    const before = points[index - steps]
    if (now === undefined || before === undefined) return null
    return ((now.cumPlaced - before.cumPlaced) / windowSeconds) * 3_600
  }
</script>

<div class="relative" bind:clientWidth={width}>
  <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-base-content/70">
    <span class="inline-flex items-center gap-1.5">
      <span class="size-2.5 rounded-xs" style:background="var(--chart-correct)"></span> correct
    </span>
    <span class="inline-flex items-center gap-1.5">
      <span class="size-2.5 rounded-xs bg-error/60"></span> painted, mismatched
    </span>
    <span class="ms-2 text-base-content/40">pace:</span>
    {#each WINDOWS as window, index (window.key)}
      {@const usable = windowUsable(window.seconds)}
      <button
        class="inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 transition-colors
          {usable ? 'hover:bg-base-200' : 'cursor-not-allowed opacity-35'}
          {enabledWindows.has(window.key) && usable ? 'bg-base-200' : ''}"
        disabled={!usable}
        title={usable
          ? `toggle the ${window.key} rolling pace line`
          : `needs finer data than the current ${resolution}s buckets`}
        onclick={() => toggleWindow(window.key)}
      >
        <span
          class="rounded-full"
          style:width="10px"
          style:height="{paceWidth(index / (WINDOWS.length - 1)) + 1}px"
          style:background={paceColor(index / (WINDOWS.length - 1))}
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
        <text x={x(tick)} y={height - 6} text-anchor="middle" class="fill-base-content/50 text-[10px]">
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
        d={points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yLeft(p.cumCorrect).toFixed(1)}`)
          .join('')}
        fill="none"
        stroke="var(--chart-correct)"
        stroke-width="1.5"
      />

      {#each activePaces as pace (pace.key)}
        <path
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
          {@const value = hoverPace(pace.seconds, hover.t)}
          {#if value !== null}
            <div class="tabular-nums text-base-content/70">
              pace {pace.key}: {formatCount(value)} px/h
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
