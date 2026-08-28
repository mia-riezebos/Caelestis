<script lang="ts">
  import type { ContributionDay, HistoryBucket, LeaderboardEntry } from '@caelestis/shared'
  import { getContributions, getHistory, getLeaderboard } from '$lib/api/client'
  import ContributionHeatmap from '$lib/components/charts/ContributionHeatmap.svelte'
  import ProgressPaceChart from '$lib/components/charts/ProgressPaceChart.svelte'
  import Leaderboard from '$lib/components/Leaderboard.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import type { Progress } from '$lib/tree'

  let {
    templateIds,
    season,
    progress,
  }: {
    templateIds: readonly string[]
    season: number
    /** The scope's live status — the progress chart's anchor and the ETA's numerator. */
    progress: Progress
  } = $props()

  const remainingPixels = $derived(progress.total - progress.completed)

  // One fixed window; every pace horizon is a line in the chart, not a mode of the panel.
  const WINDOW_SECONDS = 604_800
  const RESOLUTION = 900

  const now = Math.floor(Date.now() / 1000)
  const from = Math.floor((now - WINDOW_SECONDS) / RESOLUTION) * RESOLUTION
  const to = Math.ceil(now / RESOLUTION) * RESOLUTION

  let history = $state<HistoryBucket[] | null>(null)
  let contributions = $state<readonly ContributionDay[] | null>(null)
  let leaderboard = $state<readonly LeaderboardEntry[] | null>(null)
  let failed = $state(false)

  $effect(() => {
    if (templateIds.length === 0) return
    const generation = { cancelled: false }
    history = null
    failed = false
    getHistory(templateIds, from, to)
      .then((response) => {
        if (!generation.cancelled) history = [...response.buckets]
      })
      .catch(() => {
        if (!generation.cancelled) failed = true
      })
    return () => {
      generation.cancelled = true
    }
  })

  $effect(() => {
    if (templateIds.length === 0) return
    const ids = [...templateIds]
    const generation = { cancelled: false }
    const contributionFrom = now - 86_400 * 7 * 16
    getContributions(ids, contributionFrom, now)
      .then((response) => {
        if (!generation.cancelled) contributions = response.days
      })
      .catch(() => {})
    getLeaderboard(season, { templateIds: ids })
      .then((response) => {
        if (!generation.cancelled) leaderboard = response.entries
      })
      .catch(() => {})
    return () => {
      generation.cancelled = true
    }
  })

  // Show the last 24 hours as pixels per hour.
  const pace = $derived.by(() => {
    if (history === null) return null
    const cutoff = to - 86_400
    let placed = 0
    let correct = 0
    for (const bucket of history) {
      if (bucket.bucketStart >= cutoff) {
        placed += bucket.placed
        correct += bucket.correct
      }
    }
    return { placed: placed / 24, correct: correct / 24 }
  })

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
      <h2 class="font-semibold">Progress &amp; pace <span class="text-xs font-normal text-base-content/50">last 7 days</span></h2>
      <div class="text-xs tabular-nums text-base-content/60">
        {#if pace !== null}
          {Math.round(pace.placed).toLocaleString()} px/h over the last day
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
