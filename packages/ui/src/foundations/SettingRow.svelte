<script lang="ts">
  import type { Snippet } from 'svelte'

  let { label, hint, children }: { label: string; hint?: string; children: Snippet } = $props()
</script>

<div class="row">
  <div class="copy">
    <span>{label}</span>
    {#if hint !== undefined}<small>{hint}</small>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-block-size: 3rem; padding: 0.5rem 0.75rem; color: var(--caelestis-text, inherit); font: 500 0.85rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .copy { display: flex; flex: 1; min-inline-size: 0; flex-direction: column; }
  small { color: var(--caelestis-muted-text, color-mix(in oklch, currentColor 60%, transparent)); font-size: 0.72rem; }
  .control { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; }
</style>
