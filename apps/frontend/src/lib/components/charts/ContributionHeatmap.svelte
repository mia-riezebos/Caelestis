<script lang="ts">
import type { ContributionDay } from '@caelestis/shared'

let {
  days,
  weeks = 16,
}: {
  days: readonly ContributionDay[]
  weeks?: number
} = $props()

const DAY = 86_400

// Sum per calendar day across painters and templates. Reporter de-duplication already happened
// server-side, so summing these rows is safe.
const byDay = $derived.by(() => {
  const totals = new Map<number, number>()
  for (const day of days) totals.set(day.day, (totals.get(day.day) ?? 0) + day.placed)
  return totals
})

// The grid ends on today's UTC day and runs back `weeks` columns, GitHub-style: one column per
// week, top row Monday.
const grid = $derived.by(() => {
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY
  const weekday = (Math.floor(today / DAY) + 3) % 7 // 1970-01-01 was a Thursday; 0 = Monday.
  const lastMonday = today - weekday * DAY
  const columns: { day: number; placed: number | null }[][] = []
  for (let w = weeks - 1; w >= 0; w--) {
    const column: { day: number; placed: number | null }[] = []
    for (let d = 0; d < 7; d++) {
      const day = lastMonday - w * 7 * DAY + d * DAY
      column.push({ day, placed: day > today ? null : (byDay.get(day) ?? 0) })
    }
    columns.push(column)
  }
  return columns
})

const max = $derived(Math.max(1, ...byDay.values()))

// Sequential single-hue ramp: level by quarter of the observed maximum, zero stays surface.
const level = (placed: number): string => {
  if (placed === 0) return 'color-mix(in oklab, var(--color-base-content) 8%, transparent)'
  const step = Math.min(5, Math.max(1, Math.ceil((placed / max) * 5)))
  return `var(--heat-${step})`
}

const label = (day: number, placed: number): string =>
  `${new Date(day * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${placed.toLocaleString()} pixels`
</script>

<div class="flex flex-col gap-1.5">
  <!-- Cells share the card's width instead of a fixed size, so sixteen weeks read as a graph
       rather than as a stamp in the corner of an otherwise empty panel. -->
  <div class="grid w-full max-w-xl gap-[3px]" style:grid-template-columns="repeat({weeks}, minmax(0, 1fr))">
    {#each grid as column, c (c)}
      <div class="flex flex-col gap-[3px]">
        {#each column as cell (cell.day)}
          {#if cell.placed === null}
            <span class="aspect-square w-full rounded-xs"></span>
          {:else}
            <span
              class="aspect-square w-full rounded-xs"
              style:background={level(cell.placed)}
              title={label(cell.day, cell.placed)}
              aria-label={label(cell.day, cell.placed)}
              role="img"
            ></span>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
  <div class="flex w-full max-w-xl items-center justify-end gap-1 text-[10px] text-base-content/50">
    less
    <span class="size-2.5 rounded-xs" style:background="color-mix(in oklab, var(--color-base-content) 8%, transparent)"></span>
    {#each [1, 2, 3, 4, 5] as step (step)}
      <span class="size-2.5 rounded-xs" style:background="var(--heat-{step})"></span>
    {/each}
    more
  </div>
</div>
