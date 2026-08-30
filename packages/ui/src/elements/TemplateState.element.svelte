<svelte:options
  customElement={{
    shadow: 'open',
    props: {
      finished: { reflect: true, type: 'Boolean' },
      frozen: { reflect: true, type: 'Boolean' },
      griefed: { reflect: true, type: 'Boolean' },
      alarmKind: { attribute: 'alarm-kind', reflect: true, type: 'String' },
      pixelsLost: { attribute: 'pixels-lost', reflect: true, type: 'Number' },
      compact: { reflect: true, type: 'Boolean' },
    },
  }}
/>

<script lang="ts">
  import TemplateState from '../template-state/TemplateState.svelte'
  import type { TemplateStateProps } from '../types.js'

  let {
    finished = false,
    frozen = false,
    griefed = false,
    alarmKind,
    pixelsLost,
    compact = false,
  }: TemplateStateProps = $props()
</script>

<TemplateState {finished} {frozen} {griefed} {alarmKind} {pixelsLost} {compact} />

<style>
  :host {
    display: inline-flex;
    max-inline-size: 100%;
  }
</style>
