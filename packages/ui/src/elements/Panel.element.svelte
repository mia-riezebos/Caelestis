<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import Panel from '../panel/Panel.svelte'
  import type { PanelIntent, PanelModel } from '../types.js'

  const DEFAULT_MODEL: PanelModel = { view: 'tree', width: 360, minWidth: 260, maxWidth: 720 }
  let { model = DEFAULT_MODEL }: { model?: PanelModel } = $props()
  const element: HTMLElement = $host()

  $effect(() => { element.style.width = `${model.width}px` })

  const emit = (detail: PanelIntent): void => {
    if (detail.type === 'resize-preview' || detail.type === 'resize-commit') {
      element.style.width = `${detail.width}px`
    }
    element.dispatchEvent(new CustomEvent('caelestis-panel-intent', { detail, bubbles: true, composed: true }))
  }
</script>

{#snippet content()}<svelte:element this={'slot'} />{/snippet}
<Panel {model} onIntent={emit} children={content} />

<style>
  :host { display: block; min-block-size: 0; }
</style>
