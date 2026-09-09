<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import Backfill from '../backfill/Backfill.svelte'
  import type { BackfillIntent, BackfillModel } from '../backfill/model.js'
  let { model }: { model: BackfillModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: BackfillIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-backfill-intent', { detail, bubbles: true, composed: true })) }
</script>
<Backfill {model} onIntent={emit} />
<style>:host { display: block; }</style>
