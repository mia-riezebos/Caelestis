<svelte:options
  customElement={{
    shadow: 'open',
    props: {
      finished: { reflect: true, type: 'Boolean' },
      frozen: { reflect: true, type: 'Boolean' },
      busy: { reflect: true, type: 'Boolean' },
    },
  }}
/>

<script lang="ts">
  import TemplateAdmin from '../template-admin/TemplateAdmin.svelte'
  import type { TemplateAdminProps, TemplateLifecycleChangeDetail } from '../types.js'

  let { finished = false, frozen = false, busy = false }: TemplateAdminProps = $props()
  const element: HTMLElement = $host()

  const emit = (name: string, detail: TemplateLifecycleChangeDetail): void => {
    element.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }
</script>

<TemplateAdmin
  {finished}
  {frozen}
  {busy}
  onFinishedChange={(detail) => emit('caelestis-finished-change', detail)}
  onFrozenChange={(detail) => emit('caelestis-frozen-change', detail)}
/>

<style>
  :host {
    display: inline-flex;
    max-inline-size: 100%;
  }
</style>
