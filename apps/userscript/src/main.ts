import { TILE_SIZE, tileKey } from '@wts/shared'
import { installDebugApi, log } from './debug.js'
import { installMapCapture } from './map-handle.js'
import { anchorOffset, DEFAULT_APPEARANCE } from './templates/appearance.js'
import {
  levelFor,
  localTemplates,
  onLocalChange,
  restoreLocalTemplates,
  stampTile,
} from './templates/local-store.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { loadAccount } from './wplace-account.js'

/**
 * Entry point.
 *
 * The overlay is our own canvas stacked over MapLibre's, aligned from MapLibre's own projection
 * matrix rather than a reimplementation of it. Each frame it draws the tiles wplace is showing,
 * with our templates on top — nothing is composited into wplace's own tiles, so per-colour filters
 * and view modes stay possible.
 */

const overlayCanvas = (): HTMLCanvasElement => {
  const existing = document.querySelector<HTMLCanvasElement>('canvas[data-wts-overlay]')
  if (existing !== null) return existing
  const canvas = document.createElement('canvas')
  canvas.dataset.wtsOverlay = ''
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // The map has to stay draggable through us.
  canvas.style.pointerEvents = 'none'
  return canvas
}

let lastFrame: TileFrame | null = null

const draw = (frame: TileFrame): void => {
  lastFrame = frame
  const { canvas: mapCanvas, quads } = frame
  const canvas = overlayCanvas()
  if (canvas.parentElement === null) mapCanvas.parentElement?.appendChild(canvas)
  if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
    canvas.width = mapCanvas.width
    canvas.height = mapCanvas.height
  }

  const context = canvas.getContext('2d')
  if (context === null) return
  // Cleared unconditionally, including on frames with no tiles, so zooming out past the point where
  // wplace stops serving tiles does not strand the last frame on screen.
  context.clearRect(0, 0, canvas.width, canvas.height)

  const visible = localTemplates().filter((template) => template.visible)
  if (visible.length === 0) return

  let drawn = 0
  for (const quad of quads) {
    const key = tileKey(quad.tile)
    // Match wplace's own texture filtering, measured off their GL calls: LINEAR when minifying,
    // NEAREST when magnifying. Pixel art must stay crisp past 100%, and must stop shimmering below
    // it — one setting cannot do both, which is why they switch and so do we.
    const magnifying = quad.width >= TILE_SIZE
    context.imageSmoothingEnabled = !magnifying
    if (!magnifying) context.imageSmoothingQuality = 'high'

    for (const template of visible) {
      const appearance = template.appearance ?? DEFAULT_APPEARANCE
      // Shape and colour filtering are baked into a stamped bitmap rather than applied per pixel
      // per frame; the stamp is rebuilt only when the appearance changes.
      const tile = stampTile(template, key, appearance)
      if (tile === undefined) continue
      context.globalAlpha = appearance.opacity
      // Draw from the mip level nearest the on-screen size, so filtering never reduces by more
      // than 2x. One drawImage per tile per template, whatever the template's size.
      const bitmap = magnifying ? (tile.levels[0] as ImageBitmap) : levelFor(tile, quad.width)
      // Snap both edges to whole device pixels, and derive width from the snapped edges rather
      // than rounding the width itself.
      //
      // MapLibre hands us fractional quads, and two neighbours that abut exactly in canvas space
      // land on edges like 511.6 and 511.9 — so one tile stops a fraction before the next starts
      // and the background shows through as a hairline seam. Rounding each edge with the same rule
      // makes a shared boundary land on the same integer from both sides, so they meet exactly.
      const left = Math.round(quad.x)
      const top = Math.round(quad.y)
      const right = Math.round(quad.x + quad.width)
      const bottom = Math.round(quad.y + quad.height)
      context.drawImage(bitmap, left, top, right - left, bottom - top)
      context.globalAlpha = 1
      drawn++
    }
  }
  // The button rides with the overlay, so it is repositioned on the same frame the map moved.
  renderOverlayControls(() => {
    if (lastFrame !== null) draw(lastFrame)
  })

  const w = window as unknown as Record<string, unknown>
  w.__wtsFrame = `${quads.length} tiles, ${drawn} drawn, quadWidth=${Math.round(quads[0]?.width ?? 0)}, smoothing=${context.imageSmoothingEnabled}`
  w.__wtsMips =
    visible[0]?.tiles
      .values()
      .next()
      .value?.levels.map((l) => l.width)
      .join(',') ?? 'none'
  if (drawn > 0) log('draw', `painted ${drawn} template tiles`, { quads: quads.length })
}

/** Where the middle of the viewport is, in canvas pixels — used to place an image on import. */
export const viewportCentre = (): { x: number; y: number } | null => {
  if (lastFrame === null || lastFrame.quads.length === 0) return null
  const canvas = lastFrame.canvas
  const midX = canvas.width / 2
  const midY = canvas.height / 2
  for (const quad of lastFrame.quads) {
    if (midX < quad.x || midX >= quad.x + quad.width) continue
    if (midY < quad.y || midY >= quad.y + quad.height) continue
    const scale = TILE_SIZE / quad.width
    return {
      x: quad.tile.x * TILE_SIZE + (midX - quad.x) * scale,
      y: quad.tile.y * TILE_SIZE + (midY - quad.y) * scale,
    }
  }
  // No tile under the centre: fall back to the first one we have, which is still in view.
  const first = lastFrame.quads[0]
  if (first === undefined) return null
  return { x: first.tile.x * TILE_SIZE, y: first.tile.y * TILE_SIZE }
}

/** Canvas pixel under a screen point, for centring a template on the cursor. */
export const canvasPixelAt = (
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  if (lastFrame === null) return null
  const box = lastFrame.canvas.getBoundingClientRect()
  const ratio = lastFrame.canvas.width / box.width
  const px = (clientX - box.left) * ratio
  const py = (clientY - box.top) * ratio
  for (const quad of lastFrame.quads) {
    if (px < quad.x || px >= quad.x + quad.width) continue
    if (py < quad.y || py >= quad.y + quad.height) continue
    const scale = TILE_SIZE / quad.width
    return {
      x: quad.tile.x * TILE_SIZE + (px - quad.x) * scale,
      y: quad.tile.y * TILE_SIZE + (py - quad.y) * scale,
    }
  }
  return null
}

/**
 * Where a canvas pixel currently sits on screen, in client coordinates.
 *
 * The inverse of `canvasPixelAt`, and what makes closed-loop navigation possible: we can see where
 * a target is without being able to ask MapLibre to go there.
 */
export const screenPointFor = (x: number, y: number): { x: number; y: number } | null => {
  if (lastFrame === null) return null
  const reference = lastFrame.quads[0]
  if (reference === undefined) return null
  const box = lastFrame.canvas.getBoundingClientRect()
  const ratio = lastFrame.canvas.width / box.width
  // Any one tile fixes the whole mapping: the scale is uniform and the map is never rotated, so a
  // single quad is a complete reference frame. Requiring the point to fall *inside* a visible tile
  // meant a template whose corner was just off-screen had no position at all — which is exactly
  // when its controls need to stay reachable.
  const scale = reference.width / TILE_SIZE
  const originX = reference.tile.x * TILE_SIZE
  const originY = reference.tile.y * TILE_SIZE
  return {
    x: box.left + (reference.x + (x - originX) * scale) / ratio,
    y: box.top + (reference.y + (y - originY) * scale) / ratio,
  }
}

/** Screen scale: how many device pixels one canvas pixel currently occupies. */
export const pixelsPerCanvasPixel = (): number => {
  const quad = lastFrame?.quads[0]
  return quad === undefined ? 1 : quad.width / TILE_SIZE
}

const main = (): void => {
  // Before anything else: the trap has to be in place before MapLibre constructs its Map.
  installMapCapture()
  installDebugApi({})
  install()
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  void restoreLocalTemplates()
  void loadAccount()
  onTileFrame(draw)
  // A template appearing or moving has to repaint even if MapLibre is idle.
  onLocalChange(() => {
    if (lastFrame !== null) draw(lastFrame)
  })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPanel, { once: true })
  } else {
    installPanel()
  }
  console.info(`[wts] loaded — tile size ${TILE_SIZE}`)
}

main()
