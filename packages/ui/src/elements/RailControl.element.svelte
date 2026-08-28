<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import RailControl from '../rail/RailControl.svelte'
  import type { RailControlIntent, RailControlModel } from '../types.js'

  const DEFAULT_MODEL: RailControlModel = { id: 'panel', label: 'Caelestis', pressed: false }
  let { model = DEFAULT_MODEL }: { model?: RailControlModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: RailControlIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-rail-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<RailControl {model} onIntent={emit} />

<style>:host { display: block; }</style>
