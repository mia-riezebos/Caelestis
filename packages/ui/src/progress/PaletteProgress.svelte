<script lang="ts">
  import type { PaletteProgressModel } from '../types.js'

  let { model }: { model: PaletteProgressModel } = $props()
</script>

<span aria-hidden="true">{model.value}</span>

<style>
  :global(*) { box-sizing: border-box; }
  span { display: block; min-inline-size: 1.25rem; padding-inline: 0.1875rem; border-radius: 999px; background: rgb(15 18 24 / 0.82); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.2); color: #fff; font: 650 0.5625rem/0.875rem ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; pointer-events: none; text-align: center; }
</style>
