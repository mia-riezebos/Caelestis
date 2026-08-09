import { TILE_SIZE } from '@wts/shared'
import {
  canvasPixelAtIn,
  pixelsPerCanvasPixelIn,
  screenPointForIn,
  viewportCentreIn,
} from './coordinates.js'
import { installDebugApi, log } from './debug.js'
import { installMapCapture } from './map-handle.js'
import { type FramePainter, paintFrame } from './paint.js'
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
export type Painter = FramePainter

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
  paintFrame(context, frame, painters)

  log('frame', 'painted', { quads: quads.length, painters: painters.length })
}

/** Where the middle of the viewport is, in canvas pixels — used to place an image on import. */
export const viewportCentre = (): { x: number; y: number } | null => {
  return lastFrame === null ? null : viewportCentreIn(lastFrame)
}

/** Canvas pixel under a screen point, for centring something on the cursor. */
export const canvasPixelAt = (
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  return lastFrame === null ? null : canvasPixelAtIn(lastFrame, clientX, clientY)
}

/**
 * Where a canvas pixel currently sits on screen, in client coordinates.
 *
 * The inverse of `canvasPixelAt`, and what lets us position DOM controls against a point on the
 * canvas: we can see where a target is without asking MapLibre anything.
 */
export const screenPointFor = (x: number, y: number): { x: number; y: number } | null => {
  return lastFrame === null ? null : screenPointForIn(lastFrame, x, y)
}

/** Screen scale: how many device pixels one canvas pixel currently occupies. */
export const pixelsPerCanvasPixel = (): number => {
  return pixelsPerCanvasPixelIn(lastFrame)
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
