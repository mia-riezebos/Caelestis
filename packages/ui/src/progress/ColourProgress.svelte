<script lang="ts">
  import { type TemplateColourStatus, WPLACE_PALETTE } from '@caelestis/shared'
  import type { ColourProgressSort } from '../types.js'

  let { colours, sort = 'index', onSortChange }: {
    colours: readonly TemplateColourStatus[]
    sort?: ColourProgressSort
    onSortChange?: (sort: ColourProgressSort) => void
  } = $props()

  const sorts: ReadonlyArray<{ key: ColourProgressSort; label: string }> = [
    { key: 'index', label: 'palette index' },
    { key: 'progress', label: 'highest %' },
    { key: 'progress-asc', label: 'lowest %' },
    { key: 'remaining', label: 'most left' },
    { key: 'remaining-asc', label: 'least left' },
    { key: 'total', label: 'biggest' },
    { key: 'free', label: 'free first' },
    { key: 'premium', label: 'premium first' },
  ]

  const rows = $derived.by(() => {
    const resolved = colours.flatMap((colour) => {
      const palette = WPLACE_PALETTE[colour.index]
      return palette === undefined
        ? []
        : [{
            colour,
            palette,
            done: colour.total === 0 ? 0 : colour.correct / colour.total,
            remaining: colour.total - colour.correct,
          }]
    })
    const byIndex = (a: (typeof resolved)[number], b: (typeof resolved)[number]) =>
      a.colour.index - b.colour.index
    switch (sort) {
      case 'progress': return resolved.sort((a, b) => b.done - a.done || byIndex(a, b))
      case 'progress-asc': return resolved.sort((a, b) => a.done - b.done || byIndex(a, b))
      case 'remaining': return resolved.sort((a, b) => b.remaining - a.remaining || byIndex(a, b))
      case 'remaining-asc': return resolved.sort((a, b) => a.remaining - b.remaining || byIndex(a, b))
      case 'total': return resolved.sort((a, b) => b.colour.total - a.colour.total || byIndex(a, b))
      case 'free': return resolved.sort((a, b) => Number(a.palette.kind !== 'free') - Number(b.palette.kind !== 'free') || byIndex(a, b))
      case 'premium': return resolved.sort((a, b) => Number(a.palette.kind !== 'premium') - Number(b.palette.kind !== 'premium') || byIndex(a, b))
      default: return resolved.sort(byIndex)
    }
  })
</script>

<div class="toolbar">
  <label for="caelestis-colour-sort">Sort by</label>
  <select id="caelestis-colour-sort" value={sort} onchange={(event) => onSortChange?.(event.currentTarget.value as ColourProgressSort)}>
    {#each sorts as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
  </select>
</div>
<ul>
  {#each rows as { colour, palette, done } (colour.index)}
    <li>
      <span class="index">{colour.index}</span>
      <span class="swatch" style:background={palette.hex} title={`${palette.name} (${palette.kind})`}></span>
      <span class="name" title={palette.name}>{palette.name}</span>
      <span class="track"><span style:width={`${done * 100}%`} style:background={palette.hex}></span></span>
      <span class="count" title={`${colour.correct.toLocaleString()} of ${colour.total.toLocaleString()} pixels`}>{colour.correct.toLocaleString()}/{colour.total.toLocaleString()}</span>
      <span class="percent">{(done * 100).toFixed(1)}%</span>
    </li>
  {/each}
</ul>

<style>
  .toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; margin-block-end: 0.5rem; color: var(--caelestis-muted-text); font: 500 0.72rem/1.2 ui-sans-serif, system-ui, sans-serif; }
  select { min-block-size: 1.75rem; inline-size: 9rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.65rem); background: var(--caelestis-raised-surface); color: var(--caelestis-text); }
  ul { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding: 0; list-style: none; }
  li { display: grid; grid-template-columns: 1.5rem 1rem minmax(5rem, 9rem) minmax(4rem, 1fr) 8.5rem; align-items: center; gap: 0.5rem; color: var(--caelestis-text); font: 500 0.8rem/1.2 ui-sans-serif, system-ui, sans-serif; }
  .index, .count, .percent { color: var(--caelestis-muted-text); text-align: end; font-size: 0.72rem; font-variant-numeric: tabular-nums; }
  .swatch { inline-size: 1rem; block-size: 1rem; border: 1px solid color-mix(in oklch, var(--caelestis-text) 20%, transparent); border-radius: 0.2rem; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { block-size: 0.375rem; overflow: hidden; border-radius: 999px; background: var(--caelestis-raised-surface); }
  .track > span { display: block; block-size: 100%; border-radius: inherit; }
  .percent { display: none; }
  @media (max-width: 40rem) { li { grid-template-columns: 1.5rem 1rem minmax(3rem, 1fr) 5.5rem; } .name, .count { display: none; } .percent { display: block; } }
</style>
