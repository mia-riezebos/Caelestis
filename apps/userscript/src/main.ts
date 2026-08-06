import { TILE_SIZE, tileKey } from '@wts/shared'
import { installDebugApi, log } from './debug.js'
import { localTemplates, onLocalChange, restoreLocalTemplates } from './templates/local-store.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'
import { installPanel } from './ui/panel.js'

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
  // Templates are pixel art; smoothing turns them to mush the moment a tile is drawn larger than
  // its 1000px source, which is most of the time.
  context.imageSmoothingEnabled = false

  const visible = localTemplates().filter((template) => template.visible)
  if (visible.length === 0) return

  let drawn = 0
  for (const quad of quads) {
    const key = tileKey(quad.tile)
    for (const template of visible) {
      const bitmap = template.tiles.get(key)
      if (bitmap === undefined) continue
      // The bitmap is one whole tile, so it maps exactly onto the quad MapLibre gave us — no
      // per-pixel arithmetic, one drawImage per tile per template.
      context.drawImage(bitmap, quad.x, quad.y, quad.width, quad.height)
      drawn++
    }
  }
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
  const box = lastFrame.canvas.getBoundingClientRect()
  const ratio = lastFrame.canvas.width / box.width
  for (const quad of lastFrame.quads) {
    const left = quad.tile.x * TILE_SIZE
    const top = quad.tile.y * TILE_SIZE
    if (x < left || x >= left + TILE_SIZE) continue
    if (y < top || y >= top + TILE_SIZE) continue
    const scale = quad.width / TILE_SIZE
    return {
      x: box.left + (quad.x + (x - left) * scale) / ratio,
      y: box.top + (quad.y + (y - top) * scale) / ratio,
    }
  }
  return null
}

/** Screen scale: how many device pixels one canvas pixel currently occupies. */
export const pixelsPerCanvasPixel = (): number => {
  const quad = lastFrame?.quads[0]
  return quad === undefined ? 1 : quad.width / TILE_SIZE
}

const main = (): void => {
  installDebugApi({})
  install()
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  void restoreLocalTemplates()
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
