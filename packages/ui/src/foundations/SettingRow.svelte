<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    label,
    hint,
    children,
    compact = false,
    depth,
  }: { label: string; hint?: string | undefined; children: Snippet; compact?: boolean; depth?: number } = $props()
</script>

<div class:compact class:hierarchy={depth !== undefined} class="row" data-depth={depth} style:--depth={depth ?? 0}>
  <div class="copy">
    <span>{label}</span>
    {#if hint !== undefined}<small>{hint}</small>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-block-size: 3rem; padding: 0.5rem var(--caelestis-content-inset, 1rem); color: var(--caelestis-text, inherit); font: 400 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .copy { display: flex; flex: 1; min-inline-size: 0; flex-direction: column; }
  small { color: var(--caelestis-muted-text, color-mix(in oklch, currentColor 60%, transparent)); font-size: 0.75rem; }
  .control { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; }
  .compact { min-block-size: 2rem; padding: 0.25rem; gap: 0.75rem; font-size: 0.75rem; }
  .compact .copy { opacity: 0.8; }
  .hierarchy { display: grid; grid-template-columns: minmax(0, 1fr) 8.5rem; gap: 0.75rem; min-block-size: 0; padding: 0.375rem 0; padding-inline-start: calc(1.25rem * var(--depth)); }
  .hierarchy .control { min-inline-size: 0; }
  .hierarchy:is([data-depth='1'], [data-depth='2']) .copy { font-size: 0.75rem; opacity: 0.8; }
  .hierarchy.compact { padding-block: 0.25rem; }
</style>
