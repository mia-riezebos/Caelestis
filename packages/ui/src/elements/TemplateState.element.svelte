<svelte:options
  customElement={{
    shadow: 'open',
    props: {
      finished: { reflect: true, type: 'Boolean' },
      frozen: { reflect: true, type: 'Boolean' },
      griefed: { reflect: true, type: 'Boolean' },
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
    compact = false,
  }: TemplateStateProps = $props()
</script>

<TemplateState {finished} {frozen} {griefed} {compact} />

<style>
  :host {
    display: inline-flex;
    max-inline-size: 100%;
  }
</style>
