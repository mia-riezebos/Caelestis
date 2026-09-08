<script lang="ts" module>
  export type { IconName } from './icons.js'
</script>

<script lang="ts">
  import { ICONS, type IconName } from './icons.js'

  let { name, size = '1rem' }: { name: IconName; size?: string } = $props()
  const icon = $derived(ICONS[name])
</script>

<!-- Iconify bodies are static markup from the package, each path already carrying fill="currentColor". -->
<svg viewBox={`0 0 ${icon.width ?? 24} ${icon.height ?? 24}`} fill="currentColor" aria-hidden="true" style:width={size} style:height={size}>{@html icon.body}</svg>

<style>
  svg { flex-shrink: 0; }
</style>
