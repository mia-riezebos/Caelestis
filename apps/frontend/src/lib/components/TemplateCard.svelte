<script lang="ts">
import type { CanvasTileSummary, TileKey } from '@caelestis/shared'
import ProgressMeter from '$lib/components/ProgressMeter.svelte'
import TemplateCanvas from '$lib/components/TemplateCanvas.svelte'
import type { TreeTemplate } from '$lib/tree'

let {
  entry,
  canvas,
}: {
  entry: TreeTemplate
  canvas: ReadonlyMap<TileKey, CanvasTileSummary>
} = $props()

const { template } = $derived(entry)
</script>

<a
  href="/template/{template.id}"
  class="group flex flex-col overflow-hidden rounded-2xl border-[1.5px] border-base-300 bg-base-100 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary"
>
  <div class="flex h-44 justify-center overflow-hidden border-b-[1.5px] border-base-300">
    <TemplateCanvas {template} {canvas} class="h-44 w-auto" />
  </div>
  <div class="flex flex-col gap-2 p-3">
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="truncate font-semibold group-hover:text-primary">{template.name}</h3>
      <span class="shrink-0 text-xs tabular-nums text-base-content/50">
        {template.totalPixels.toLocaleString()} px
      </span>
    </div>
    <ProgressMeter progress={entry.progress} size="sm" />
  </div>
</a>
