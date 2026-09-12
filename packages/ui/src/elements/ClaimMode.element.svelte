<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ClaimMode from '../claim/ClaimMode.svelte'
  import type { ClaimModeIntent, ClaimModeModel } from '../types.js'
  let { model }: { model: ClaimModeModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: ClaimModeIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-claim-mode-intent', { detail, bubbles: true, composed: true })) }
</script>
<ClaimMode {model} onIntent={emit} />
<style>:host { display: block; }</style>
