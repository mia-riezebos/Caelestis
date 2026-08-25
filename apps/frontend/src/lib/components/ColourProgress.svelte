<script lang="ts">
import { type TemplateColourStatus, WPLACE_PALETTE } from '@caelestis/shared'

let { colours }: { colours: readonly TemplateColourStatus[] } = $props()

/**
 * Keep the sort choices familiar to painters. The remaining and total orders help choose the next
 * colour. Free and premium orders match partial palette ownership.
 */
const SORTS = [
  { key: 'index', label: 'palette index' },
  { key: 'progress', label: 'highest %' },
  { key: 'progress-asc', label: 'lowest %' },
  { key: 'remaining', label: 'most left' },
  { key: 'remaining-asc', label: 'least left' },
  { key: 'total', label: 'biggest' },
  { key: 'free', label: 'free first' },
  { key: 'premium', label: 'premium first' },
] as const
type SortKey = (typeof SORTS)[number]['key']

let sortBy = $state<SortKey>('index')

const rows = $derived.by(() => {
  const resolved = colours
    .map((colour) => ({
      colour,
      palette: WPLACE_PALETTE[colour.index],
      done: colour.total === 0 ? 0 : colour.correct / colour.total,
      remaining: colour.total - colour.correct,
    }))
    .filter((row) => row.palette !== undefined)
  const byIndex = (a: (typeof resolved)[number], b: (typeof resolved)[number]) =>
    a.colour.index - b.colour.index
  switch (sortBy) {
    case 'progress':
      return resolved.sort((a, b) => b.done - a.done || byIndex(a, b))
    case 'progress-asc':
      return resolved.sort((a, b) => a.done - b.done || byIndex(a, b))
    case 'remaining':
      return resolved.sort((a, b) => b.remaining - a.remaining || byIndex(a, b))
    case 'remaining-asc':
      return resolved.sort((a, b) => a.remaining - b.remaining || byIndex(a, b))
    case 'total':
      return resolved.sort((a, b) => b.colour.total - a.colour.total || byIndex(a, b))
    case 'free':
      return resolved.sort(
        (a, b) =>
          Number(a.palette?.kind !== 'free') - Number(b.palette?.kind !== 'free') || byIndex(a, b),
      )
    case 'premium':
      return resolved.sort(
        (a, b) =>
          Number(a.palette?.kind !== 'premium') - Number(b.palette?.kind !== 'premium') ||
          byIndex(a, b),
      )
    default:
      return resolved.sort(byIndex)
  }
})
</script>

<!-- Each row uses its palette colour for the swatch and progress meter. -->
<div class="mb-2 flex items-center justify-end gap-2">
  <label class="text-xs text-base-content/60" for="colour-sort">Sort by</label>
  <select
    id="colour-sort"
    class="select select-bordered select-xs w-36"
    bind:value={sortBy}
  >
    {#each SORTS as sort (sort.key)}
      <option value={sort.key}>{sort.label}</option>
    {/each}
  </select>
</div>
<ul class="flex flex-col gap-1.5">
  {#each rows as { colour, palette, done } (colour.index)}
    <li class="grid grid-cols-[auto_auto_9rem_1fr_8.5rem] items-center gap-2 text-sm max-sm:grid-cols-[auto_auto_1fr_5.5rem]">
      <span class="w-6 text-end text-xs tabular-nums text-base-content/40">{colour.index}</span>
      <span
        class="size-4 shrink-0 rounded-sm border border-base-content/20"
        style:background={palette?.hex}
        title="{palette?.name} ({palette?.kind})"
      ></span>
      <span class="truncate text-base-content/80 max-sm:hidden" title={palette?.name}>{palette?.name}</span>
      <div class="h-1.5 overflow-hidden rounded-full bg-base-200">
        <div
          class="h-full rounded-full"
          style:width="{done * 100}%"
          style:background={palette?.hex}
        ></div>
      </div>
      <!-- A fixed column: `auto` here let long counts steal track from the bar, so two colours at
           the same percentage drew different lengths. -->
      <span
        class="text-end text-xs tabular-nums text-base-content/60 max-sm:hidden"
        title="{colour.correct.toLocaleString()} of {colour.total.toLocaleString()} pixels"
      >
        {colour.correct.toLocaleString()}/{colour.total.toLocaleString()}
      </span>
      <span class="text-end text-xs tabular-nums text-base-content/60 sm:hidden">
        {(done * 100).toFixed(1)}%
      </span>
    </li>
  {/each}
</ul>
