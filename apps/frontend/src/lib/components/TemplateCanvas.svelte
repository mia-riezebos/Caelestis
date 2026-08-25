<script lang="ts">
import type { CanvasTileSummary, Template, TileKey } from '@caelestis/shared'
import {
  drawCanvasTiles,
  drawTemplateChunks,
  paddedRect,
  templateRect,
  tileUnionRect,
} from '$lib/render'
import { cn } from '$lib/utils'

let {
  template,
  canvas,
  overlayAlpha = 1,
  class: className,
}: {
  template: Template
  /** Latest observed tile per key; missing keys stay transparent (never scanned). */
  canvas: ReadonlyMap<TileKey, CanvasTileSummary>
  /** 0 hides the template art, 1 paints it solid over the observed canvas. */
  overlayAlpha?: number
  class?: string
} = $props()

// Include nearby canvas within the template's tiles. This keeps the card preview grounded in place.
const rect = $derived(paddedRect(templateRect(template), 0.5, tileUnionRect(template)))

let tilesLayer = $state<HTMLCanvasElement | null>(null)
let artLayer = $state<HTMLCanvasElement | null>(null)

// The observed canvas and the template art live on separate stacked layers, so the overlay
// slider is a CSS opacity change rather than a recomposite of every image.
$effect(() => {
  const layer = tilesLayer
  if (layer === null) return
  const ctx = layer.getContext('2d')
  if (ctx === null) return
  const controller = new AbortController()
  ctx.clearRect(0, 0, rect.width, rect.height)
  drawCanvasTiles(
    ctx,
    rect,
    (key) => canvas.get(key)?.hash,
    controller.signal,
    () => {},
  )
  return () => controller.abort()
})

$effect(() => {
  const layer = artLayer
  if (layer === null) return
  const ctx = layer.getContext('2d')
  if (ctx === null) return
  const controller = new AbortController()
  ctx.clearRect(0, 0, rect.width, rect.height)
  drawTemplateChunks(ctx, rect, template, 1, controller.signal, () => {})
  return () => controller.abort()
})
</script>

<div
  class={cn('alpha-checker relative overflow-hidden', className)}
  style:aspect-ratio="{rect.width} / {rect.height}"
>
  <canvas
    bind:this={tilesLayer}
    width={rect.width}
    height={rect.height}
    class="pixelated absolute inset-0 h-full w-full"
    aria-label="observed canvas under {template.name}"
  ></canvas>
  <canvas
    bind:this={artLayer}
    width={rect.width}
    height={rect.height}
    class="pixelated absolute inset-0 h-full w-full"
    style:opacity={overlayAlpha}
    aria-label="{template.name} template art"
  ></canvas>
</div>
