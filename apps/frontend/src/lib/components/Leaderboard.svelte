<script lang="ts">
import type { LeaderboardEntry } from '@caelestis/shared'
import * as Table from '$lib/components/ui/table'

let { entries }: { entries: readonly LeaderboardEntry[] } = $props()

const medal = (rank: number): string | null =>
  rank === 1
    ? 'text-accent'
    : rank === 2
      ? 'text-base-content/60'
      : rank === 3
        ? 'text-warning/80'
        : null

const relativeDay = (day: number): string => {
  const days = Math.floor(Date.now() / 1000 / 86_400) - Math.floor(day / 86_400)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
</script>

{#if entries.length === 0}
  <div class="flex h-32 items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/50">
    No contributions yet. Paint activity appears here when userscript reporting is on.
  </div>
{:else}
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head class="w-10">#</Table.Head>
        <Table.Head>Painter</Table.Head>
        <Table.Head class="text-right">Correct</Table.Head>
        <Table.Head class="text-right">Placed</Table.Head>
        <Table.Head class="text-right">Repairs</Table.Head>
        <Table.Head class="text-right max-sm:hidden">Active days</Table.Head>
        <Table.Head class="text-right max-sm:hidden">Last seen</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each entries as entry, index (entry.wplaceUserId)}
        {@const rank = index + 1}
        <Table.Row>
          <Table.Cell class="font-pixel text-xs {medal(rank) ?? 'text-base-content/50'}">{rank}</Table.Cell>
          <Table.Cell>
            <span class="font-medium">{entry.displayName || `user ${entry.wplaceUserId}`}</span>
            <span class="ml-1.5 text-xs text-base-content/40 tabular-nums">#{entry.wplaceUserId}</span>
          </Table.Cell>
          <Table.Cell class="text-right font-semibold tabular-nums">{entry.correct.toLocaleString()}</Table.Cell>
          <Table.Cell class="text-right tabular-nums text-base-content/70">{entry.placed.toLocaleString()}</Table.Cell>
          <Table.Cell class="text-right tabular-nums text-base-content/70">{entry.repairs.toLocaleString()}</Table.Cell>
          <Table.Cell class="text-right tabular-nums text-base-content/70 max-sm:hidden">{entry.activeDays}</Table.Cell>
          <Table.Cell class="text-right text-base-content/70 max-sm:hidden">{relativeDay(entry.lastDay)}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
{/if}
