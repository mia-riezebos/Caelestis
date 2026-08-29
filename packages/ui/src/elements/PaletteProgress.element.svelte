<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import PaletteProgress from '../progress/PaletteProgress.svelte'
  import type { PaletteProgressModel } from '../types.js'

  let { model = { value: '' } }: { model?: PaletteProgressModel } = $props()
</script>

<PaletteProgress {model} />

<style>
  :host { position: absolute; z-index: 1; inset-block-end: 0.125rem; inset-inline-end: 0.125rem; display: block; pointer-events: none; }
</style>
