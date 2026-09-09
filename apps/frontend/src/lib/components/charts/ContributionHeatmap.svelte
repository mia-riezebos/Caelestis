<script lang="ts">
import type { ContributionDay } from '@caelestis/shared'

let {
  days,
  weeks = 53,
}: {
  days: readonly ContributionDay[]
  /** How many weeks of history to keep; narrower cards drop the oldest columns, never the newest. */
  weeks?: number
} = $props()

const DAY = 86_400
const CELL = 11
const GAP = 2
const AXIS = 30

let width = $state(0)

// Sum per calendar day across painters and templates. Reporter de-duplication already happened
// server-side, so summing these rows is safe.
const byDay = $derived.by(() => {
  const totals = new Map<number, number>()
  for (const day of days) totals.set(day.day, (totals.get(day.day) ?? 0) + day.placed)
  return totals
})

// Columns that fit the card, ending on the current week so today is always the rightmost cell.
const shown = $derived(
  width === 0 ? weeks : Math.max(4, Math.min(weeks, Math.floor((width - AXIS) / (CELL + GAP)))),
)

// GitHub-style: one column per week, top row Monday, the grid ends on today's UTC day.
const grid = $derived.by(() => {
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY
  const weekday = (Math.floor(today / DAY) + 3) % 7 // 1970-01-01 was a Thursday; 0 = Monday.
  const lastMonday = today - weekday * DAY
  const columns: { day: number; placed: number | null }[][] = []
  for (let w = shown - 1; w >= 0; w--) {
    const column: { day: number; placed: number | null }[] = []
    for (let d = 0; d < 7; d++) {
      const day = lastMonday - w * 7 * DAY + d * DAY
      column.push({ day, placed: day > today ? null : (byDay.get(day) ?? 0) })
    }
    columns.push(column)
  }
  return columns
})

// A month label sits over the first column whose Monday falls in that month. The oldest label is
// dropped when the next one lands within two columns, so two names never overlap.
const months = $derived.by(() => {
  const labels: { column: number; text: string }[] = []
  let previous = -1
  grid.forEach((column, index) => {
    const monday = column[0]?.day
    if (monday === undefined) return
    const date = new Date(monday * 1000)
    if (date.getUTCMonth() === previous) return
    previous = date.getUTCMonth()
    labels.push({
      column: index,
      text: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
    })
  })
  const [first, second] = labels
  return first !== undefined && second !== undefined && second.column - first.column < 3
    ? labels.slice(1)
    : labels
})

const weekdays = ['Mon', '', 'Wed', '', 'Fri', '', '']

const max = $derived(Math.max(1, ...byDay.values()))

// Split the observed range into five levels. Keep zero at the base colour.
const level = (placed: number): string => {
  if (placed === 0) return 'color-mix(in oklab, var(--color-base-content) 8%, transparent)'
  const step = Math.min(5, Math.max(1, Math.ceil((placed / max) * 5)))
  return `var(--heat-${step})`
}

const label = (day: number, placed: number): string =>
  `${new Date(day * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${placed.toLocaleString()} pixels`
</script>

<div
  bind:clientWidth={width}
  class="flex flex-col items-end gap-1 text-[10px] leading-none text-base-content/50"
  style:--cell="{CELL}px"
  style:--gap="{GAP}px"
>
  <div class="flex" style:gap="{AXIS - CELL * 2}px">
    <span class="shrink-0" style:width="{CELL * 2}px"></span>
    <div class="relative h-3 flex-1">
      {#each months as month (month.column)}
        <span class="absolute top-0" style:left="calc({month.column} * (var(--cell) + var(--gap)))">{month.text}</span>
      {/each}
    </div>
  </div>
  <div class="flex" style:gap="{AXIS - CELL * 2}px">
    <div class="flex shrink-0 flex-col" style:width="{CELL * 2}px" style:gap="var(--gap)">
      {#each weekdays as weekday, index (index)}
        <span class="flex items-center" style:height="var(--cell)">{weekday}</span>
      {/each}
    </div>
    <div class="grid" style:grid-template-columns="repeat({shown}, var(--cell))" style:gap="var(--gap)">
      {#each grid as column, c (c)}
        <div class="flex flex-col" style:gap="var(--gap)">
          {#each column as cell (cell.day)}
            {#if cell.placed === null}
              <span class="rounded-[2px]" style:width="var(--cell)" style:height="var(--cell)"></span>
            {:else}
              <span
                class="rounded-[2px]"
                style:width="var(--cell)"
                style:height="var(--cell)"
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
  </div>
  <div class="flex items-center gap-1 pt-1">
    less
    <span class="rounded-[2px]" style:width="var(--cell)" style:height="var(--cell)" style:background="color-mix(in oklab, var(--color-base-content) 8%, transparent)"></span>
    {#each [1, 2, 3, 4, 5] as step (step)}
      <span class="rounded-[2px]" style:width="var(--cell)" style:height="var(--cell)" style:background="var(--heat-{step})"></span>
    {/each}
    more
  </div>
</div>
