<script lang="ts">
  import { TILE_SIZE, type Template, type TileKey, WORLD_TILES } from '@caelestis/shared'
  import { Maximize, Minus, Plus } from '@lucide/svelte'
  import {
    type CanvasRect,
    chunkImage,
    chunkPlacements,
    osmImage,
    osmSpan,
    osmTileDrawRect,
    osmZoomFor,
    templateRect,
    tileImage,
    tilesInRect,
    tileUnionRect,
  } from '$lib/render'
  import { cn } from '$lib/utils'

  let {
    template,
    hashFor,
    overlayAlpha = 1,
    class: className,
  }: {
    template: Template
    /** Select the live canvas or a timelapse frame for each tile. */
    hashFor: (key: TileKey) => string | undefined
    overlayAlpha?: number
    class?: string
  } = $props()

  // The template's own tiles plus a one-tile ring: the server's 6-hour fetcher mirrors the ring
  // too, so panning past the artwork keeps showing real canvas before the basemap takes over.
  const world = $derived.by<CanvasRect>(() => {
    const union = tileUnionRect(template)
    const x = Math.max(0, union.x - TILE_SIZE)
    const y = Math.max(0, union.y - TILE_SIZE)
    return {
      x,
      y,
      width: Math.min(WORLD_TILES * TILE_SIZE, union.x + union.width + TILE_SIZE) - x,
      height: Math.min(WORLD_TILES * TILE_SIZE, union.y + union.height + TILE_SIZE) - y,
    }
  })
  const art = $derived(templateRect(template))
  const chunks = $derived(chunkPlacements(template))

  let container = $state<HTMLDivElement | null>(null)
  let visible = $state<HTMLCanvasElement | null>(null)
  let viewWidth = $state(0)
  let viewHeight = $state(0)

  // World-space point at the view origin plus scale: screen = (world - origin) * zoom.
  let zoom = $state(1)
  let originX = $state(0)
  let originY = $state(0)
  let fitted = false

  const MAX_ZOOM = 40

  const fitToArt = (): void => {
    if (viewWidth === 0 || viewHeight === 0) return
    const margin = 1.15
    zoom = Math.min(viewWidth / (art.width * margin), viewHeight / (art.height * margin), MAX_ZOOM)
    originX = art.x + art.width / 2 - viewWidth / 2 / zoom
    originY = art.y + art.height / 2 - viewHeight / 2 / zoom
  }

  const minZoom = $derived(
    viewWidth === 0
      ? 0.01
      : Math.min(viewWidth / world.width, viewHeight / world.height, 1) * 0.9,
  )

  const clampView = (): void => {
    zoom = Math.min(MAX_ZOOM, Math.max(minZoom, zoom))
    // Keep at least a sliver of the world on screen.
    const slack = 200 / zoom
    originX = Math.min(
      world.x + world.width - slack,
      Math.max(world.x - viewWidth / zoom + slack, originX),
    )
    originY = Math.min(
      world.y + world.height - slack,
      Math.max(world.y - viewHeight / zoom + slack, originY),
    )
  }

  /**
   * Draw only images inside the viewport. Draw the basemap first, then canvas tiles and template
   * art. Redraw when an image loads instead of allocating a world-sized buffer.
   */
  const ready = new Map<string, HTMLImageElement>()
  const pending = new Set<string>()
  /** Last successfully decoded canvas observation per tile, independent of the selected frame. */
  const presentedTiles = new Map<TileKey, HTMLImageElement>()

  const ensure = (key: string, load: () => Promise<HTMLImageElement>): HTMLImageElement | null => {
    const held = ready.get(key)
    if (held !== undefined) return held
    if (!pending.has(key)) {
      pending.add(key)
      load()
        .then((image) => {
          ready.set(key, image)
          schedulePresent()
        })
        .catch(() => {})
        .finally(() => pending.delete(key))
    }
    return null
  }

  let presentQueued = false

  const present = (): void => {
    const canvas = visible
    if (canvas === null || viewWidth === 0) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const dpr = window.devicePixelRatio || 1
    const scale = zoom * dpr
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scale, 0, 0, scale, -originX * scale, -originY * scale)

    const visibleRect = {
      x: originX,
      y: originY,
      width: viewWidth / zoom,
      height: viewHeight / zoom,
    }

    // Draw the basemap across the viewport, including areas beyond the mirrored canvas.
    const z = osmZoomFor(scale)
    const span = osmSpan(z)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const firstOsmX = Math.floor(visibleRect.x / span)
    const lastOsmX = Math.floor((visibleRect.x + visibleRect.width) / span)
    const firstOsmY = Math.max(0, Math.floor(visibleRect.y / span))
    const lastOsmY = Math.min(2 ** z - 1, Math.floor((visibleRect.y + visibleRect.height) / span))
    for (let ty = firstOsmY; ty <= lastOsmY; ty++) {
      for (let tx = firstOsmX; tx <= lastOsmX; tx++) {
        const wrappedX = ((tx % 2 ** z) + 2 ** z) % 2 ** z
        const image = ensure(`osm:${z}/${wrappedX}/${ty}`, () => osmImage(z, wrappedX, ty))
        if (image !== null) {
          const destination = osmTileDrawRect(tx, ty, span, scale)
          ctx.drawImage(
            image,
            destination.x,
            destination.y,
            destination.width,
            destination.height,
          )
        }
      }
    }

    // wplace's own answer to moiré, measured off its GL calls: LINEAR below 1:1, NEAREST above.
    ctx.imageSmoothingEnabled = scale < 1

    for (const placement of tilesInRect(world)) {
      const drawX = world.x + placement.drawX
      const drawY = world.y + placement.drawY
      if (
        drawX + TILE_SIZE < visibleRect.x ||
        drawX > visibleRect.x + visibleRect.width ||
        drawY + TILE_SIZE < visibleRect.y ||
        drawY > visibleRect.y + visibleRect.height
      )
        continue
      const hash = hashFor(placement.key)
      const loaded = hash === undefined ? null : ensure(`tile:${hash}`, () => tileImage(hash))
      if (hash !== undefined && loaded !== null) {
        presentedTiles.set(placement.key, loaded)
      }
      // A requested frame becomes visible only after it decoded. Pending, missing, and failed blobs
      // keep the last valid observation instead of exposing the basemap as a false blank. An
      // undefined hash means the selected time predates this tile's first observation, so a live or
      // later image must not leak backwards into that historical frame.
      const image = hash === undefined ? null : (loaded ?? presentedTiles.get(placement.key) ?? null)
      if (image !== null) ctx.drawImage(image, drawX, drawY)
    }

    if (overlayAlpha > 0) {
      ctx.globalAlpha = overlayAlpha
      for (const chunk of chunks) {
        const image = ensure(`chunk:${chunk.hash}`, () => chunkImage(chunk.hash))
        if (image !== null) ctx.drawImage(image, chunk.x, chunk.y)
      }
      ctx.globalAlpha = 1
    }
  }

  // A microtask, not requestAnimationFrame: rAF never fires in an occluded tab, so a zoom or a
  // scrub done while the window is covered would silently draw nothing.
  const schedulePresent = (): void => {
    if (presentQueued) return
    presentQueued = true
    queueMicrotask(() => {
      presentQueued = false
      present()
    })
  }

  // Size the visible canvas to the container at device resolution; first fit once measured.
  $effect(() => {
    const element = container
    const canvas = visible
    if (element === null || canvas === null) return
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      viewWidth = element.clientWidth
      viewHeight = element.clientHeight
      canvas.width = Math.max(1, Math.round(viewWidth * dpr))
      canvas.height = Math.max(1, Math.round(viewHeight * dpr))
      if (!fitted && viewWidth > 0) {
        fitted = true
        fitToArt()
      }
      schedulePresent()
    })
    observer.observe(element)
    return () => observer.disconnect()
  })

  $effect(() => {
    void zoom
    void originX
    void originY
    void overlayAlpha
    void hashFor
    void template
    schedulePresent()
  })

  const zoomAt = (screenX: number, screenY: number, factor: number): void => {
    const worldX = originX + screenX / zoom
    const worldY = originY + screenY / zoom
    zoom = Math.min(MAX_ZOOM, Math.max(minZoom, zoom * factor))
    originX = worldX - screenX / zoom
    originY = worldY - screenY / zoom
    clampView()
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    zoomAt(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      Math.exp(-event.deltaY * 0.0022),
    )
  }

  // Drag pan plus two-finger pinch, both through pointer events.
  const pointers = new Map<number, { x: number; y: number }>()
  let pinchDistance = 0

  const onPointerDown = (event: PointerEvent): void => {
    // Capturing here retargets the eventual click to the container, so a press that begins on a
    // zoom button must not start a drag because capture would swallow its click.
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a !== undefined && b !== undefined) pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    const previous = pointers.get(event.pointerId)
    if (previous === undefined) return
    const current = { x: event.clientX, y: event.clientY }
    pointers.set(event.pointerId, current)
    if (pointers.size === 1) {
      originX -= (current.x - previous.x) / zoom
      originY -= (current.y - previous.y) / zoom
      clampView()
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a === undefined || b === undefined) return
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDistance > 0) {
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
        zoomAt(
          (a.x + b.x) / 2 - bounds.left,
          (a.y + b.y) / 2 - bounds.top,
          distance / pinchDistance,
        )
      }
      pinchDistance = distance
    }
  }

  const onPointerUp = (event: PointerEvent): void => {
    pointers.delete(event.pointerId)
    pinchDistance = 0
  }
</script>

<div
  bind:this={container}
  class={cn('relative touch-none overflow-hidden bg-base-200 select-none', className)}
  role="application"
  aria-label="pannable view of {template.name} on the canvas"
  onwheel={onWheel}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <canvas bind:this={visible} class="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
  ></canvas>

  <div class="absolute end-2 top-2 flex flex-col gap-1">
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="zoom in" onclick={() => zoomAt(viewWidth / 2, viewHeight / 2, 1.5)}>
      <Plus class="size-3.5" />
    </button>
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="zoom out" onclick={() => zoomAt(viewWidth / 2, viewHeight / 2, 1 / 1.5)}>
      <Minus class="size-3.5" />
    </button>
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="fit template" onclick={() => { fitToArt(); }}>
      <Maximize class="size-3.5" />
    </button>
  </div>

  <a
    href="https://www.openstreetmap.org/copyright"
    target="_blank"
    rel="noreferrer"
    class="absolute bottom-1 end-2 rounded bg-base-100/70 px-1.5 text-[10px] text-base-content/70"
  >
    © OpenStreetMap
  </a>
</div>
