<script lang="ts">
  import type { Snippet } from 'svelte'

  let { title, icon }: { title: string; icon?: Snippet } = $props()
</script>

<div class="section">
  <span class="chip" aria-hidden="true">{#if icon !== undefined}{@render icon()}{/if}</span>
  <h2>{title}</h2>
</div>

<style>
  .section { display: flex; align-items: center; gap: 0.5rem; padding: 1.25rem 0.75rem 0.5rem; color: var(--caelestis-text, inherit); }
  .chip { display: grid; flex: 0 0 auto; place-items: center; inline-size: 1.75rem; block-size: 1.75rem; border-radius: 0.5rem; background: var(--caelestis-raised-surface, oklch(0.92 0.01 264)); }
  h2 { margin: 0; font: 700 0.85rem/1.2 ui-sans-serif, system-ui, sans-serif; }
</style>
