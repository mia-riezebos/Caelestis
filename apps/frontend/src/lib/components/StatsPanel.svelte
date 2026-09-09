<script lang="ts">
  import { formatCount, formatPixels } from '@caelestis/shared'
  import type {
    ContributionDay,
    ArchiveHistory,
    HistoryBucket,
    ProgressSample,
    LeaderboardEntry,
    PainterTotal,
    Template,
  } from '@caelestis/shared'
  import {
    getArchiveHistory,
    getContributions,
    getHistory,
    getProgressHistory,
    getLeaderboard,
    getPainterHistory,
    getPainterTotals,
  } from '$lib/api/client'
  import ContributionHeatmap from '$lib/components/charts/ContributionHeatmap.svelte'
  import { combineArchiveSamples } from '$lib/archive-history'
  import { combineProgressSamples } from '$lib/progress-history'
  import {
    defaultVisiblePainters,
    MAX_PAINTER_OPTIONS,
    MAX_SELECTED_PAINTERS,
    togglePainterSelection,
  } from '$lib/components/charts/painter-pace'
  import ProgressPaceChart from '$lib/components/charts/ProgressPaceChart.svelte'
  import {
    PACE_WINDOWS,
    type PaceHistorySource,
    type PainterHistorySource,
    averagePace,
  } from '$lib/components/charts/progress-pace'
  import Leaderboard from '$lib/components/Leaderboard.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { persisted } from '$lib/persisted.svelte'
  import type { Progress } from '$lib/tree'
  import type { DashboardSnapshot } from '$lib/state/app.svelte'

  let {
    templates,
    season,
    liveDashboard,
    progress,
    subscribeDashboard,
  }: {
    templates: readonly Template[]
    season: number
    liveDashboard: boolean
    /** Current canvas status for the chart's current point and the ETA's numerator. */
    progress: Progress
    subscribeDashboard: (
      templateIds: readonly string[],
      contributionsFrom: number,
      listener: (snapshot: DashboardSnapshot) => void,
    ) => () => void
  } = $props()

  const templateIds = $derived(templates.map((template) => template.id))
  const remainingPixels = $derived(progress.total - progress.completed)

  const DAY_SECONDS = 86_400
  const RESOLUTION = 900
  const STATS_REFRESH_MS = 15_000

  let archives = $state<readonly ArchiveHistory[]>([])
  let archiveError = $state<string | null>(null)
  const archiveSamples = $derived(combineArchiveSamples(archives))
  $effect(() => {
    const scope = templates.map((template) => ({ id: template.id, version: template.version }))
    let cancelled = false
    archives = []; archiveError = null
    // Bound upstream concurrency for large folders; snapshot reads need no painter subscriptions.
    void (async () => {
      const results: ArchiveHistory[] = []
      for (const template of scope) {
        if (cancelled) return
        results.push(await getArchiveHistory(template.id, template.version))
      }
      if (!cancelled) archives = results
    })().catch(() => { if (!cancelled) archiveError = 'Imported progress history could not load.' })
    return () => { cancelled = true }
  })

  let liveTo = $state(Math.floor(Date.now() / 1_000) + 1)
  // Start at a day boundary so every retained tier can return the bucket containing creation.
  const from = $derived.by(
    () =>
      Math.floor(
        Math.min(...templates.map((template) => template.createdAt / 1_000)) / DAY_SECONDS,
      ) * DAY_SECONDS,
  )
  const displayFrom = $derived(Math.min(from, ...archiveSamples.map((sample) => sample.at)))
  const hasLiveTemplate = $derived(templates.some((template) => template.finishedAt === null))
  const to = $derived.by(() => {
    const finishedAt = templates.map((template) => template.finishedAt)
    return hasLiveTemplate
      ? liveTo
      : Math.floor(Math.max(...finishedAt.map((finished) => finished ?? 0)) / 1_000) + 1
  })

  let history = $state<HistoryBucket[] | null>(null)
  let progressSamples = $state<readonly ProgressSample[]>([])
  let progressError = $state<string | null>(null)
  let progressScope: string | undefined
  // Current counts stream separately; saved history needs only a slow refresh.
  const PROGRESS_REFRESH_SECONDS = 5 * 60
  const progressTo = $derived(
    hasLiveTemplate ? Math.floor(to / PROGRESS_REFRESH_SECONDS) * PROGRESS_REFRESH_SECONDS + 1 : to,
  )
  $effect(() => {
    const scope = templates.map((template) => ({ id: template.id, version: template.version }))
    const start = from
    const end = progressTo
    const key = JSON.stringify([scope, start])
    if (progressScope !== key) {
      progressScope = key
      progressSamples = []
      progressError = null
    }
    let cancelled = false
    void (async () => {
      const histories: (readonly ProgressSample[])[] = []
      for (const template of scope) {
        if (cancelled) return
        histories.push((await getProgressHistory(template.id, template.version, start, end)).samples)
      }
      if (!cancelled) {
        progressSamples = combineProgressSamples(histories)
        progressError = null
      }
    })().catch(() => {
      if (!cancelled) {
        progressSamples = []
        progressError = 'Saved progress history could not load.'
      }
    })
    return () => {
      cancelled = true
    }
  })
  let paceHistories = $state<readonly PaceHistorySource[]>([])
  let contributions = $state<readonly ContributionDay[] | null>(null)
  let leaderboard = $state<readonly LeaderboardEntry[] | null>(null)
  /** The rolling pace windows the chart draws; shared so painter lines are fetched for the same. */
  const storedWindows = persisted<string[]>('caelestis:pace-windows', ['1h', '6h'])
  /** Who painted in the scope, leading first: the picker's list and the source of the default set. */
  let painters = $state<readonly PainterTotal[]>([])
  // The leading painters draw by default. The picker records an override per painter, so the
  // default set can shift with the data without undoing anyone's choices.
  let painterOverrides = $state<Record<number, boolean>>({})
  const defaultPainters = $derived(defaultVisiblePainters(painters))
  const painterShown = (wplaceUserId: number): boolean =>
    painterOverrides[wplaceUserId] ?? defaultPainters.has(wplaceUserId)
  const selectedPainters = $derived(
    new Set(
      painters
        .filter((painter) => painterShown(painter.wplaceUserId))
        .map((painter) => painter.wplaceUserId),
    ),
  )
  // Never past the history route's bound: one refused request would take every line with it.
  const togglePainter = (wplaceUserId: number): void => {
    painterOverrides = togglePainterSelection(painterOverrides, selectedPainters, wplaceUserId)
  }
  /** The selected painters' retained tiers for each enabled rolling window, like `paceHistories`. */
  let painterHistories = $state<readonly PainterHistorySource[]>([])
  let failed = $state(false)
  let historyScope: string | undefined

  // Historical chart windows keep advancing independently of live dashboard subscriptions.
  $effect(() => {
    if (!hasLiveTemplate) return
    const refresh = (): void => {
      if (document.visibilityState === 'visible') liveTo = Math.floor(Date.now() / 1_000) + 1
    }
    refresh()
    const interval = setInterval(refresh, STATS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refresh)
    }
  })

  $effect(() => {
    if (templateIds.length === 0) return
    const generation = { cancelled: false }
    const scope = `${templateIds.join('\0')}:${from}`
    if (historyScope !== scope) {
      historyScope = scope
      history = null
      paceHistories = []
    }
    failed = false
    getHistory(templateIds, from, to)
      .then((response) => {
        if (!generation.cancelled) history = [...response.buckets]
      })
      .catch(() => {
        if (!generation.cancelled) failed = true
      })
    Promise.all(
      PACE_WINDOWS.map(async (window): Promise<PaceHistorySource | null> => {
        try {
          const paceHistory = await getHistory(templateIds, from, to, {
            // Two buckets are the minimum honest representation of a rolling window.
            maxResolution: window.seconds / 2,
          })
          return { window: window.key, history: paceHistory }
        } catch {
          // The coarse history still renders against servers without bounded-tier queries.
          return null
        }
      }),
    ).then((responses) => {
      if (!generation.cancelled) {
        paceHistories = responses.filter((response) => response !== null)
      }
    })
    return () => {
      generation.cancelled = true
    }
  })

  $effect(() => {
    if (templateIds.length === 0) return
    const ids = [...templateIds]
    contributions = null
    leaderboard = null
    // The heatmap draws up to a year of weeks, and that is all this read is for: painter pace comes from
    // the bucket ladder below, at whatever range the scope has.
    const contributionsFrom = Math.floor(Date.now() / 1_000) - 86_400 * 7 * 53
    if (liveDashboard)
      return subscribeDashboard(ids, contributionsFrom, (snapshot) => {
        contributions = snapshot.contributions.days
        leaderboard = snapshot.leaderboard.entries
      })

    const generation = { cancelled: false }
    let refreshPending = false
    const refresh = (): void => {
      if (refreshPending) return
      refreshPending = true
      const requestedAt = Math.floor(Date.now() / 1_000)
      void Promise.all([
        getContributions(ids, requestedAt - 86_400 * 7 * 53, requestedAt).then((response) => {
          if (!generation.cancelled) contributions = response.days
        }),
        getLeaderboard(season, { templateIds: ids }).then((response) => {
          if (!generation.cancelled) leaderboard = response.entries
        }),
      ])
        .catch(() => {})
        .finally(() => {
          refreshPending = false
        })
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    const interval = setInterval(refreshWhenVisible, STATS_REFRESH_MS)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      generation.cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  })

  // Who painted is one bounded list per scope, summed by the server, refreshed on its own slow
  // clock. Painter lines then read the same ladder as the template lines: one retained tier per
  // enabled rolling window, for the selected painters only. A window nobody enabled and a painter
  // nobody chose are never fetched, so a crowded server pays for what it draws.
  const PAINTERS_REFRESH_MS = 5 * 60_000
  let painterScope: string | undefined
  $effect(() => {
    if (templateIds.length === 0) return
    const ids = [...templateIds]
    const generation = { cancelled: false }
    const scope = `${ids.join('\0')}:${from}`
    if (painterScope !== scope) {
      painterScope = scope
      painters = []
      painterOverrides = {}
      painterHistories = []
    }
    const refresh = (): void => {
      const requestedAt = Math.floor(Date.now() / 1_000) + 1
      getPainterTotals(ids, from, requestedAt, { limit: MAX_PAINTER_OPTIONS })
        .then((response) => {
          if (!generation.cancelled) painters = response.painters
        })
        .catch(() => {
          // A server without painter buckets still draws the template lines.
        })
    }
    refresh()
    const interval = setInterval(refresh, PAINTERS_REFRESH_MS)
    return () => {
      generation.cancelled = true
      clearInterval(interval)
    }
  })

  $effect(() => {
    if (templateIds.length === 0) return
    const generation = { cancelled: false }
    const enabled = new Set(storedWindows.value)
    const chosen = [...selectedPainters].slice(0, MAX_SELECTED_PAINTERS)
    if (chosen.length === 0) {
      painterHistories = []
      return
    }
    Promise.all(
      PACE_WINDOWS.filter((window) => enabled.has(window.key)).map(
        async (window): Promise<PainterHistorySource | null> => {
          try {
            const history = await getPainterHistory(templateIds, chosen, from, to, {
              maxResolution: window.seconds / 2,
            })
            return { window: window.key, history }
          } catch {
            return null
          }
        },
      ),
    ).then((responses) => {
      if (!generation.cancelled) {
        painterHistories = responses.filter((response) => response !== null)
      }
    })
    return () => {
      generation.cancelled = true
    }
  })

  // Show the last 24 hours as pixels per hour.
  const pace = $derived.by(() => {
    const source = paceHistories.find((candidate) => candidate.window === '1d')
    return source === undefined ? null : averagePace(source.history, to, DAY_SECONDS)
  })

  const pacePeriod = $derived(
    pace !== null && pace.hours < 23
      ? `over ${pace.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h within the last day`
      : 'over the last day',
  )

  const eta = $derived.by(() => {
    if (pace === null || pace.correct <= 0 || remainingPixels <= 0) return null
    const seconds = (remainingPixels / pace.correct) * 3_600
    // Beyond a year the number is noise, not a forecast.
    return seconds > 86_400 * 365 ? null : seconds
  })

  const formatEta = (seconds: number): string => {
    if (seconds < 3_600 * 36) return `~${Math.max(1, Math.round(seconds / 3_600))} h`
    return `~${Math.round(seconds / 86_400)} d`
  }
</script>

<div class="flex flex-col gap-4">
  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">Progress &amp; pace</h2>
      <div class="text-xs tabular-nums text-base-content/60">
        {#if pace !== null}
          <span class="whitespace-nowrap" title={`${formatPixels(pace.placed)} per hour`} aria-label={`${formatPixels(pace.placed)} per hour`}>{formatCount(pace.placed)} px/h</span> {pacePeriod}
          {#if eta !== null}
            · done in {formatEta(eta)} at this pace
          {/if}
        {/if}
      </div>
    </div>
    {#if failed}
      <div class="flex h-[240px] items-center justify-center text-sm text-base-content/50">
        Could not load pace history.
      </div>
    {:else if history === null}
      <Skeleton class="h-[240px] w-full" />
    {:else}
      <ProgressPaceChart
        {archiveSamples}
        {progressSamples}
        buckets={history}
        {paceHistories}
        resolution={history[0]?.resolution ?? RESOLUTION}
        from={displayFrom}
        {to}
        anchorCorrect={progress.completed}
        anchorMismatched={progress.mismatched}
        live={templates.some((template) => template.finishedAt === null)}
        {painters}
        {selectedPainters}
        onTogglePainter={togglePainter}
        {painterHistories}
        windows={storedWindows}
      />
    {/if}
    {#if archiveError}<p class="mt-2 text-sm text-error" role="alert">{archiveError}</p>{/if}
    {#if progressError}<p class="mt-2 text-sm text-error" role="alert">{progressError}</p>{/if}
  </section>

  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
    <h2 class="mb-3 font-semibold">Leaderboard</h2>
    {#if leaderboard === null}
      <Skeleton class="h-40 w-full" />
    {:else}
      <Leaderboard entries={leaderboard} />
    {/if}
  </section>

  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
    <h2 class="mb-3 font-semibold">Contributions</h2>
    {#if contributions === null}
      <Skeleton class="h-28 w-full" />
    {:else}
      <ContributionHeatmap days={contributions} />
    {/if}
  </section>
</div>
