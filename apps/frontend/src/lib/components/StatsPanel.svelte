<script lang="ts">
  import { formatCount, formatPixels } from '@caelestis/shared'
  import type {
    ContributionDay,
    HistoryBucket,
    LeaderboardEntry,
    Template,
  } from '@caelestis/shared'
  import { getContributions, getHistory, getLeaderboard } from '$lib/api/client'
  import ContributionHeatmap from '$lib/components/charts/ContributionHeatmap.svelte'
  import PainterPaceChart from '$lib/components/charts/PainterPaceChart.svelte'
  import ProgressPaceChart from '$lib/components/charts/ProgressPaceChart.svelte'
  import {
    PACE_WINDOWS,
    type PaceHistorySource,
    averagePace,
  } from '$lib/components/charts/progress-pace'
  import Leaderboard from '$lib/components/Leaderboard.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
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
    /** The scope's live status — the progress chart's anchor and the ETA's numerator. */
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

  let liveTo = $state(Math.floor(Date.now() / 1_000) + 1)
  // Start at a day boundary so every retained tier can return the bucket containing creation.
  const from = $derived.by(
    () =>
      Math.floor(
        Math.min(...templates.map((template) => template.createdAt / 1_000)) / DAY_SECONDS,
      ) * DAY_SECONDS,
  )
  const hasLiveTemplate = $derived(templates.some((template) => template.finishedAt === null))
  const to = $derived.by(() => {
    const finishedAt = templates.map((template) => template.finishedAt)
    return hasLiveTemplate
      ? liveTo
      : Math.floor(Math.max(...finishedAt.map((finished) => finished ?? 0)) / 1_000) + 1
  })

  let history = $state<HistoryBucket[] | null>(null)
  let paceHistories = $state<readonly PaceHistorySource[]>([])
  let contributions = $state<readonly ContributionDay[] | null>(null)
  /** The start of the range the served contribution days cover; earlier days were never asked for. */
  let contributionsFrom = $state(0)
  let contributionsFailed = $state(false)
  let leaderboard = $state<readonly LeaderboardEntry[] | null>(null)
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
    contributionsFailed = false
    leaderboard = null
    // The server keeps painter-days for a scope's whole lifetime, so read from its first day: the
    // heatmap only looks at its last sixteen weeks, and the painter chart draws everything.
    const requestFrom = from
    if (liveDashboard)
      return subscribeDashboard(ids, requestFrom, (snapshot) => {
        contributions = snapshot.contributions.days
        contributionsFrom = requestFrom
        leaderboard = snapshot.leaderboard.entries
      })

    const generation = { cancelled: false }
    let refreshPending = false
    const refresh = (): void => {
      if (refreshPending) return
      refreshPending = true
      const requestedAt = Math.floor(Date.now() / 1_000)
      void Promise.all([
        getContributions(ids, requestFrom, requestedAt)
          .then((response) => {
            if (generation.cancelled) return
            contributions = response.days
            contributionsFrom = requestFrom
            contributionsFailed = false
          })
          .catch((error: unknown) => {
            // A failed refresh keeps the last good chart; a failed first load says so.
            if (!generation.cancelled && contributions === null) contributionsFailed = true
            throw error
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
        buckets={history}
        {paceHistories}
        resolution={history[0]?.resolution ?? RESOLUTION}
        {from}
        {to}
        anchorCorrect={progress.completed}
        anchorMismatched={progress.mismatched}
        live={templates.some((template) => template.finishedAt === null)}
      />
    {/if}
  </section>

  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4" data-painter-pace>
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-semibold">Painter pace</h2>
      <span class="text-xs text-base-content/60">daily pixels per painter, from shared reports</span>
    </div>
    {#if contributionsFailed}
      <div class="flex h-[240px] items-center justify-center text-sm text-base-content/50">
        Could not load painter contributions.
      </div>
    {:else if contributions === null}
      <Skeleton class="h-[240px] w-full" />
    {:else}
      <PainterPaceChart
        days={contributions}
        {from}
        {to}
        coverageFrom={contributionsFrom}
        live={hasLiveTemplate}
      />
    {/if}
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
