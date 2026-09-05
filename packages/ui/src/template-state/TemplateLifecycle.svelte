<script lang="ts">
  import type { Snippet } from 'svelte'

  let { finished = false, frozen = false, children }: {
    finished?: boolean
    frozen?: boolean
    children?: Snippet
  } = $props()
</script>

<span class="lifecycle">
  <span class="template-icon">
    {#if children}{@render children()}{/if}
    {#if finished || frozen}
      <span class="indicator" class:overlay={children !== undefined} role="img" aria-label={finished ? 'Finished' : 'Timelapse frozen'} title={finished ? 'Finished' : 'Timelapse frozen'}>{finished ? '✅' : '🧊'}</span>
    {/if}
  </span>
</span>

<style>
  .lifecycle { display: inline-flex; flex: 0 0 auto; align-items: center; font: 1rem/1 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; }
  .template-icon { position: relative; display: inline-flex; }
  .template-icon:empty { display: none; }
  .indicator { display: inline-flex; align-items: center; justify-content: center; inline-size: 1rem; block-size: 1rem; }
  .indicator.overlay { position: absolute; inset-inline-end: -0.25rem; inset-block-end: -0.1875rem; inline-size: 0.75rem; block-size: 0.75rem; font-size: 0.625rem; }
</style>
