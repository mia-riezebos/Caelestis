import { TILE_SIZE } from '@wts/shared'
import { installDebugApi, log } from './debug.js'
import { installMapCapture } from './map-handle.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'

/**
 * Entry point.
 *
 * The overlay is our own canvas stacked over MapLibre's, aligned from MapLibre's own projection
 * matrix rather than a reimplementation of it. Each frame it draws over the tiles wplace is
 * showing — nothing is composited into wplace's own tiles, so per-colour filters and view modes
 * stay possible for whatever draws here later.
 *
 * This module owns the canvas and the screen/canvas coordinate conversions. It does not know what
 * gets drawn on it.
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

/** Painters registered by later layers. Each is handed the 2D context and the frame's quads. */
export type Painter = (context: CanvasRenderingContext2D, frame: TileFrame) => void

const painters: Painter[] = []

/** Register something to draw on the overlay. Called on every frame, in registration order. */
export const onPaint = (painter: Painter): void => {
  painters.push(painter)
}

/** Repaint the last frame without waiting for MapLibre — for when our own state changed, not the map's. */
export const repaint = (): void => {
  if (lastFrame !== null) draw(lastFrame)
}

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

  for (const painter of painters) painter(context, frame)

  log('frame', 'painted', { quads: quads.length, painters: painters.length })
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

/** Canvas pixel under a screen point, for centring something on the cursor. */
export const canvasPixelAt = (
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  if (lastFrame === null) return null
  const box = lastFrame.canvas.getBoundingClientRect()
  // Each axis gets its own ratio and its own quad extent. Using the horizontal one for both was
  // right only while the backing store and the CSS box shared an aspect ratio and every quad came
  // out exactly square — and a quad is accepted at up to the squareness tolerance, so neither is
  // guaranteed. Where they differed, vertical positions drifted and this stopped being the inverse
  // of `screenPointFor`.
  const ratioX = lastFrame.canvas.width / box.width
  const ratioY = lastFrame.canvas.height / box.height
  const px = (clientX - box.left) * ratioX
  const py = (clientY - box.top) * ratioY
  for (const quad of lastFrame.quads) {
    if (px < quad.x || px >= quad.x + quad.width) continue
    if (py < quad.y || py >= quad.y + quad.height) continue
    return {
      x: quad.tile.x * TILE_SIZE + ((px - quad.x) * TILE_SIZE) / quad.width,
      y: quad.tile.y * TILE_SIZE + ((py - quad.y) * TILE_SIZE) / quad.height,
    }
  }
  return null
}

/**
 * Where a canvas pixel currently sits on screen, in client coordinates.
 *
 * The inverse of `canvasPixelAt`, and what lets us position DOM controls against a point on the
 * canvas: we can see where a target is without asking MapLibre anything.
 */
export const screenPointFor = (x: number, y: number): { x: number; y: number } | null => {
  if (lastFrame === null) return null
  const reference = lastFrame.quads[0]
  if (reference === undefined) return null
  const box = lastFrame.canvas.getBoundingClientRect()
  const ratioX = lastFrame.canvas.width / box.width
  const ratioY = lastFrame.canvas.height / box.height
  // Any one tile fixes the whole mapping: the scale is uniform and the map is never rotated, so a
  // single quad is a complete reference frame. Requiring the point to fall *inside* a visible tile
  // meant a target whose position was just off-screen had no position at all — which is exactly
  // when something anchored to it needs to stay reachable.
  //
  // Per axis, so this stays the exact inverse of `canvasPixelAt` for a quad that is square only
  // within tolerance.
  const scaleX = reference.width / TILE_SIZE
  const scaleY = reference.height / TILE_SIZE
  const originX = reference.tile.x * TILE_SIZE
  const originY = reference.tile.y * TILE_SIZE
  return {
    x: box.left + (reference.x + (x - originX) * scaleX) / ratioX,
    y: box.top + (reference.y + (y - originY) * scaleY) / ratioY,
  }
}

/** Screen scale: how many device pixels one canvas pixel currently occupies. */
export const pixelsPerCanvasPixel = (): number => {
  const quad = lastFrame?.quads[0]
  return quad === undefined ? 1 : quad.width / TILE_SIZE
}

/**
 * Fill one tile, to check alignment by eye.
 *
 * `__wts.mark(1082, 1673)` paints that tile solid and it should sit exactly on the tile wplace
 * drew, through any pan or zoom. Every alignment bug so far has been visible in one glance at this
 * and invisible in the numbers, so it stays in the shipped bundle behind the debug API.
 */
let marked: { x: number; y: number } | null = null

const paintMark = (context: CanvasRenderingContext2D, frame: TileFrame): void => {
  if (marked === null) return
  for (const quad of frame.quads) {
    if (quad.tile.x !== marked.x || quad.tile.y !== marked.y) continue
    context.fillStyle = 'rgba(0, 0, 0, 0.6)'
    context.fillRect(quad.x, quad.y, quad.width, quad.height)
  }
}

const main = (): void => {
  // Before anything else: the trap has to be in place before MapLibre constructs its Map.
  installMapCapture()
  installDebugApi({
    mark(x?: number, y?: number) {
      marked = x === undefined || y === undefined ? null : { x, y }
      repaint()
      if (marked === null) return '[wts] mark cleared'
      return `[wts] marking tile ${x},${y} — __wts.mark() with no arguments to clear`
    },
  })
  install()
  onPaint(paintMark)
  onTileFrame(draw)
  console.info(`[wts] loaded — tile size ${TILE_SIZE}`)
}

main()
