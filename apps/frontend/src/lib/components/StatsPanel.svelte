<script lang="ts">
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
  import { archiveContributionDays, combineArchiveSamples } from '$lib/archive-history'
  import { combineProgressSamples } from '$lib/progress-history'
  import { completionPace } from '$lib/completion-pace'
  import {
    defaultVisiblePainters,
    MAX_PAINTER_OPTIONS,
    MAX_SELECTED_PAINTERS,
    togglePainterSelection,
    selectAllPainters,
  } from '$lib/components/charts/painter-pace'
  import ProgressPaceChart from '$lib/components/charts/ProgressPaceChart.svelte'
  import {
    PACE_WINDOWS,
    type PaceHistorySource,
    type PainterHistorySource,
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

  let archives = $state<readonly ArchiveHistory[] | null>(null)
  let archiveError = $state<string | null>(null)
  const archiveSamples = $derived(combineArchiveSamples(archives ?? []))
  $effect(() => {
    const scope = templates.map((template) => ({ id: template.id, version: template.version }))
    let cancelled = false
    archives = null; archiveError = null
    // Bound upstream concurrency for large folders; snapshot reads need no painter subscriptions.
    void (async () => {
      const results: ArchiveHistory[] = []
      for (const template of scope) {
        if (cancelled) return
        results.push(await getArchiveHistory(template.id, template.version))
      }
      if (!cancelled) archives = results
    })().catch(() => {
      if (!cancelled) {
        archives = []
        archiveError = 'Imported progress history could not load.'
      }
    })
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
  let progressSamples = $state<readonly ProgressSample[] | null>(null)
  const importedContributions = $derived(archiveContributionDays(
    archiveSamples,
    Math.min(...(history ?? []).map((bucket) => bucket.bucketStart)),
  ))
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
      progressSamples = null
      progressError = null
    }
    let cancelled = false
    void (async () => {
      const histories: (readonly ProgressSample[])[] = []
      for (const template of scope) {
        if (cancelled) return
        const history = await getProgressHistory(template.id, template.version, start, end)
        // A lifetime read can be daily; retain hourly measurements for recent zoom windows.
        const recentStart = Math.floor((end - 6 * DAY_SECONDS) / 3600) * 3600
        const samples = new Map(history.samples.map(sample => [sample.at, sample]))
        if (start < recentStart) {
          const recent = await getProgressHistory(template.id, template.version, recentStart, end)
          let covered = false
          for (const sample of recent.samples) {
            if (sample.correct !== null) covered = true
            // Only the leading unknowns lack the state carried by the lifetime read.
            if (covered) samples.set(sample.at, sample)
          }
        }
        histories.push([...samples.values()].sort((a,b) => a.at - b.at))
      }
      if (!cancelled) {
        progressSamples = combineProgressSamples(histories)
        progressError = null
      }
    })().catch(() => {
      if (!cancelled) {
        progressSamples ??= []
        progressError = 'Saved progress history could not load.'
      }
    })
    return () => {
      cancelled = true
    }
  })
  let paceHistories = $state<readonly PaceHistorySource[] | null>(null)
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
        .slice(0, MAX_SELECTED_PAINTERS)
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
      paceHistories = null
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

  const estimatePeriods = [
    { key: '1d', seconds: DAY_SECONDS, label: 'last day' },
    { key: '3d', seconds: 3 * DAY_SECONDS, label: 'last 3 days' },
    { key: '7d', seconds: 7 * DAY_SECONDS, label: 'last 7 days' },
    { key: '30d', seconds: 30 * DAY_SECONDS, label: 'last 30 days' },
    { key: '1y', seconds: 365 * DAY_SECONDS, label: 'last year' },
    { key: 'all', seconds: null, label: 'all' },
  ] as const
  const storedEstimatePeriod = persisted<string>('caelestis:estimate-period', '7d')
  const estimatePeriod = $derived(estimatePeriods.find((period) => period.key === storedEstimatePeriod.value) ?? estimatePeriods[2])
  // The 1d source already includes the entire retention ladder, including its permanent tier.
  const pace = $derived.by(() => {
    const history = paceHistories?.find((candidate) => candidate.window === '1d')?.history
    if (estimatePeriod.key === 'all') {
      if (archives === null || progressSamples === null) return null
      // Prefer native progress when both sources observed the same timestamp.
      const first = [...progressSamples, ...archiveSamples]
        .filter(sample => sample.correct !== null && sample.at < to)
        .sort((a, b) => a.at - b.at)[0]
      if (first?.correct == null) return null
      const hours = (to - first.at) / 3_600
      return { correct: (progress.completed - first.correct) / hours, hours }
    }
    return completionPace(history, archiveSamples, progressSamples ?? [], to, estimatePeriod.seconds)
  })

  const estimateCoverage = $derived(
    pace !== null && estimatePeriod.seconds !== null && pace.hours < estimatePeriod.seconds / 3_600 - 1
      ? `${(pace.hours >= 48 ? pace.hours / 24 : pace.hours).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${pace.hours >= 48 ? 'd' : 'h'} of data`
      : null,
  )

  const eta = $derived.by(() => {
    if (pace === null || pace.correct <= 0 || remainingPixels <= 0) return null
    return (remainingPixels / pace.correct) * 3_600
  })

  const formatEta = (seconds: number): string => {
    if (seconds < 3_600 * 36) return `~${Math.max(1, Math.round(seconds / 3_600))} h`
    if (seconds >= DAY_SECONDS * 365) return `~${(seconds / (DAY_SECONDS * 365)).toLocaleString(undefined, { maximumFractionDigits: 1 })} y`
    return `~${Math.round(seconds / 86_400)} d`
  }
</script>

<div class="flex flex-col gap-4">
  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">Progress &amp; pace</h2>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-base-content/60">
        <span class="font-medium text-base-content">
          {#if remainingPixels <= 0 && progress.total > 0}
            Complete
          {:else if eta !== null}
            Estimated completion in {formatEta(eta)}
          {:else}
            Completion estimate unavailable
          {/if}
        </span>
        <label class="inline-flex items-center gap-2">
          based on
          <select class="select select-xs w-auto" aria-label="Completion estimate pace period" value={estimatePeriod.key} onchange={(event) => { storedEstimatePeriod.value = event.currentTarget.value }}>
            {#each estimatePeriods as period (period.key)}
              <option value={period.key}>{period.label}</option>
            {/each}
          </select>
        </label>
        {#if estimateCoverage !== null}
          <span>({estimateCoverage})</span>
        {/if}
      </div>
    </div>
    {#if failed}
      <div class="flex h-[240px] items-center justify-center text-sm text-base-content/50">
        Could not load pace history.
      </div>
    {:else if history === null || archives === null || progressSamples === null || paceHistories === null}
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
        finished={!hasLiveTemplate}
        {painters}
        {selectedPainters}
        onTogglePainter={togglePainter}
        onSetAllPainters={(shown) => { painterOverrides = selectAllPainters(painters, shown) }}
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
      <ContributionHeatmap days={contributions} imported={importedContributions} />
    {/if}
  </section>
</div>
