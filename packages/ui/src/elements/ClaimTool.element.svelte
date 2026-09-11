<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ClaimTool from '../claim/ClaimTool.svelte'
  import type { ClaimToolIntent, ClaimToolModel } from '../types.js'
  let { model }: { model: ClaimToolModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: ClaimToolIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-claim-tool-intent', { detail, bubbles: true, composed: true })) }
</script>
<ClaimTool {model} onIntent={emit} />
<style>:host { display: block; }</style>
