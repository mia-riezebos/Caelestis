<script lang="ts">
  import type {
    ContributionDay,
    HistoryBucket,
    LeaderboardEntry,
    Template,
  } from '@caelestis/shared'
  import { getContributions, getHistory, getLeaderboard } from '$lib/api/client'
  import ContributionHeatmap from '$lib/components/charts/ContributionHeatmap.svelte'
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
  const COMPATIBILITY_REFRESH_MS = 15_000

  const now = Math.floor(Date.now() / 1_000)
  // Start at a day boundary so every retained tier can return the bucket containing creation.
  const from = $derived.by(
    () =>
      Math.floor(
        Math.min(...templates.map((template) => template.createdAt / 1_000)) / DAY_SECONDS,
      ) * DAY_SECONDS,
  )
  const to = $derived.by(() => {
    const finishedAt = templates.map((template) => template.finishedAt)
    return finishedAt.some((finished) => finished === null)
      ? now + 1
      : Math.floor(Math.max(...finishedAt.map((finished) => finished ?? 0)) / 1_000) + 1
  })

  let history = $state<HistoryBucket[] | null>(null)
  let paceHistories = $state<readonly PaceHistorySource[]>([])
  let contributions = $state<readonly ContributionDay[] | null>(null)
  let leaderboard = $state<readonly LeaderboardEntry[] | null>(null)
  let failed = $state(false)

  $effect(() => {
    if (templateIds.length === 0) return
    const generation = { cancelled: false }
    history = null
    paceHistories = []
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
    const contributionsFrom = Math.floor(Date.now() / 1_000) - 86_400 * 7 * 16
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
        getContributions(ids, requestedAt - 86_400 * 7 * 16, requestedAt).then((response) => {
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
    const interval = setInterval(refreshWhenVisible, COMPATIBILITY_REFRESH_MS)
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
          {Math.round(pace.placed).toLocaleString()} px/h {pacePeriod}
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
