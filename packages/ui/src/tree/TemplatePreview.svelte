<script lang="ts">
  import type { TreeRowModel } from '../types.js'
  import { previewPixels } from './preview-pixels.js'

  let { preview, name }: { preview: NonNullable<TreeRowModel['preview']>; name: string } = $props()
  let canvas = $state<HTMLCanvasElement>()
  let nearViewport = $state(false)
  let drawn: Uint8Array | undefined
  let drawnWidth = 0
  let drawnHeight = 0

  $effect(() => {
    if (canvas === undefined) return
    const observer = new IntersectionObserver(([entry]) => {
      nearViewport = entry?.isIntersecting === true
    }, { root: canvas.closest('[data-caelestis-scroller]'), rootMargin: '128px' })
    observer.observe(canvas)
    return () => observer.disconnect()
  })

  $effect(() => {
    const { indices, width, height } = preview
    if (canvas === undefined || !nearViewport) return
    if (indices === drawn && width === drawnWidth && height === drawnHeight) return
    const context = canvas.getContext('2d')
    if (context === null) return
    drawn = indices
    drawnWidth = width
    drawnHeight = height
    if (indices === undefined) {
      context.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    const pixels = previewPixels(indices, width, height)
    canvas.width = pixels.width
    canvas.height = pixels.height
    context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
  })
</script>

<div class="preview">
  <canvas bind:this={canvas} width="1" height="1" style:aspect-ratio={`${preview.width} / ${preview.height}`} aria-label={`${name} template art`}></canvas>
  {#if preview.indices === undefined}<span class="unavailable">Preview unavailable</span>{/if}
</div>

<style>
  .preview { position: relative; display: flex; align-items: center; justify-content: center; block-size: 8rem; padding: 0.5rem; background-color: var(--caelestis-surface); background-image: repeating-conic-gradient(color-mix(in oklab, var(--caelestis-text) 7%, transparent) 0% 25%, transparent 0% 50%); background-size: 1rem 1rem; }
  canvas { display: block; max-inline-size: 100%; max-block-size: 100%; inline-size: auto; block-size: 100%; object-fit: contain; image-rendering: pixelated; }
  .unavailable { position: absolute; color: var(--caelestis-muted-text); font-size: 0.75rem; }
</style>
