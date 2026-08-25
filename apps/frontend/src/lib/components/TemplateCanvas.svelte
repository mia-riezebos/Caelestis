<script lang="ts">
import type { CanvasTileSummary, Template, TileKey } from '@caelestis/shared'
import {
  drawCanvasTiles,
  drawTemplateChunks,
  osmImage,
  osmSpan,
  osmZoomFor,
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

let osmLayer = $state<HTMLCanvasElement | null>(null)
let tilesLayer = $state<HTMLCanvasElement | null>(null)
let artLayer = $state<HTMLCanvasElement | null>(null)

// The basemap under everything, like wplace itself. A card renders around 176 CSS pixels tall, so
// the slippy zoom is chosen for that on-screen density, not the rect's native resolution.
$effect(() => {
  const layer = osmLayer
  if (layer === null) return
  const ctx = layer.getContext('2d')
  if (ctx === null) return
  const controller = new AbortController()
  ctx.clearRect(0, 0, rect.width, rect.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const z = osmZoomFor(176 / rect.height)
  const span = osmSpan(z)
  for (let ty = Math.floor(rect.y / span); ty <= Math.floor((rect.y + rect.height - 1) / span); ty++) {
    for (let tx = Math.floor(rect.x / span); tx <= Math.floor((rect.x + rect.width - 1) / span); tx++) {
      osmImage(z, ((tx % 2 ** z) + 2 ** z) % 2 ** z, ty)
        .then((image) => {
          if (controller.signal.aborted) return
          ctx.drawImage(image, tx * span - rect.x, ty * span - rect.y, span, span)
        })
        .catch(() => {})
    }
  }
  return () => controller.abort()
})

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
  class={cn('relative overflow-hidden bg-base-200', className)}
  style:aspect-ratio="{rect.width} / {rect.height}"
>
  <canvas
    bind:this={osmLayer}
    width={rect.width}
    height={rect.height}
    class="absolute inset-0 h-full w-full"
    aria-hidden="true"
  ></canvas>
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
