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
const MIN_CELL = 10
/** Weekday label column, reserved before the grid. */
const LABEL = 24

let width = $state(0)

// Cells scale to fill the card: the grid shares the width in fractional columns. Only when a year
// of 10px cells no longer fits do the oldest weeks drop, so today always sits in the last column.
const layout = $derived.by(() => {
  if (width === 0) return { shown: weeks, gap: 2 }
  const fits = (columns: number): { shown: number; gap: number; cell: number } => {
    const step = (width - LABEL) / (columns + 1)
    const gap = Math.max(2, Math.round(step / 7))
    return { shown: columns, gap, cell: step - gap }
  }
  const all = fits(weeks)
  if (all.cell >= MIN_CELL) return all
  return fits(Math.max(4, Math.floor((width - LABEL) / (MIN_CELL + 2)) - 1))
})

// Sum per calendar day across painters and templates. Reporter de-duplication already happened
// server-side, so summing these rows is safe.
const byDay = $derived.by(() => {
  const totals = new Map<number, number>()
  for (const day of days) totals.set(day.day, (totals.get(day.day) ?? 0) + day.placed)
  return totals
})

const shown = $derived(layout.shown)

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

<div bind:clientWidth={width} class="flex flex-col gap-1 text-[10px] leading-none text-base-content/50">
  <!-- One grid for axes and cells: the label column is fixed, the week columns share the rest. -->
  <div
    class="grid w-full"
    style:grid-template-columns="{LABEL}px repeat({shown}, minmax(0, 1fr))"
    style:gap="{layout.gap}px"
  >
    <span class="h-3" style:grid-row="1" style:grid-column="1"></span>
    {#each months as month (month.column)}
      <span class="h-3 whitespace-nowrap" style:grid-row="1" style:grid-column={month.column + 2}>{month.text}</span>
    {/each}
    {#each weekdays as weekday, index (index)}
      <span class="flex items-center" style:grid-row={index + 2} style:grid-column="1">{weekday}</span>
    {/each}
    {#each grid as column, c (c)}
      {#each column as cell, d (cell.day)}
        {#if cell.placed === null}
          <span class="aspect-square w-full rounded-[2px]" style:grid-row={d + 2} style:grid-column={c + 2}></span>
        {:else}
          <span
            class="aspect-square w-full rounded-[2px]"
            style:grid-row={d + 2}
            style:grid-column={c + 2}
            style:background={level(cell.placed)}
            title={label(cell.day, cell.placed)}
            aria-label={label(cell.day, cell.placed)}
            role="img"
          ></span>
        {/if}
      {/each}
    {/each}
  </div>
  <div class="flex items-center gap-1 self-end pt-1">
    less
    <span class="size-2.5 rounded-[2px]" style:background="color-mix(in oklab, var(--color-base-content) 8%, transparent)"></span>
    {#each [1, 2, 3, 4, 5] as step (step)}
      <span class="size-2.5 rounded-[2px]" style:background="var(--heat-{step})"></span>
    {/each}
    more
  </div>
</div>
