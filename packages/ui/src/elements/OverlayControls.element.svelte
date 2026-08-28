<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import OverlayControls from '../overlay/OverlayControls.svelte'
  import type { OverlayControlsIntent, OverlayControlsModel } from '../types.js'

  const DEFAULT_MODEL: OverlayControlsModel = {
    name: 'Template',
    failures: [],
    confirmingDelete: false,
    deleting: false,
    appearance: {
      values: { size: 1, radius: 0, translateX: 0, translateY: 0, rotation: 0, opacity: 1, contrastOutline: false, contrastOutlineSize: 1, markMismatch: false, markUnpainted: false, unpaintedLimit: 0.05, markerColour: '#ff0000', markerSize: 9, markSelectedColour: false, selectedMarkerColour: '#ffffff', selectedMarkerSize: 9, dimOthers: false, otherOpacity: 0.15, otherColour: null },
      sliders: [], pixelPresets: [], colourPresets: [], palette: [], onlySelectedColour: false, paintOpen: false,
    },
  }
  let { model = DEFAULT_MODEL }: { model?: OverlayControlsModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: OverlayControlsIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-overlay-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<OverlayControls {model} onIntent={emit} />

<style>:host { display: block; max-block-size: inherit; }</style>
