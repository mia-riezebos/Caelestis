import { TILE_SIZE, tileKey } from '@wts/shared'
import {
  canvasPixelAtIn,
  cssPixelsPerCanvasPixelIn,
  screenPointForIn,
  viewportCentreIn,
} from './coordinates.js'
import { installDebugApi, log, warn } from './debug.js'
import { installMapCapture } from './map-handle.js'
import { type FramePainter, paintFrame } from './paint.js'
import { DEFAULT_APPEARANCE } from './templates/appearance.js'
import {
  levelFor,
  localTemplates,
  onLocalChange,
  previewOriginFor,
  restoreLocalTemplates,
  stampTile,
} from './templates/local-store.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'

/**
 * Entry point.
 *
 * The overlay is our own canvas stacked over MapLibre's, aligned from MapLibre's own projection
 * matrix rather than a reimplementation of it. Each frame it draws over the tiles wplace is
 * showing — nothing is composited into wplace's own tiles, so per-colour filters and view modes
 * stay possible for whatever draws here later.
 *
 * This module owns the canvas, painter registration, and the screen/canvas coordinate conversions.
 */

let retainedOverlayCanvas: HTMLCanvasElement | null = null

const overlayCanvas = (): HTMLCanvasElement => {
  if (retainedOverlayCanvas !== null) return retainedOverlayCanvas
  const existing = document.querySelector<HTMLCanvasElement>('canvas[data-wts-overlay]')
  if (existing !== null) {
    retainedOverlayCanvas = existing
    return existing
  }
  const canvas = document.createElement('canvas')
  canvas.dataset.wtsOverlay = ''
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // The map has to stay draggable through us.
  canvas.style.pointerEvents = 'none'
  retainedOverlayCanvas = canvas
  return canvas
}

let lastFrame: TileFrame | null = null

/** Painters registered by later layers. Each is handed the 2D context and the frame's quads. */
export type Painter = FramePainter

const painters: Painter[] = []

const reportPainterError = (error: unknown): void => {
  warn('frame', 'painter failed', String(error))
}

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
  const mapParent = mapCanvas.parentElement
  if (mapParent !== null && canvas.parentElement !== mapParent) mapParent.appendChild(canvas)
  if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
    canvas.width = mapCanvas.width
    canvas.height = mapCanvas.height
  }

  const context = canvas.getContext('2d')
  if (context === null) return
  // Cleared unconditionally, including on frames with no tiles, so zooming out past the point where
  // wplace stops serving tiles does not strand the last frame on screen.
  paintFrame(context, frame, painters, reportPainterError)

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

/** Whether a captured page event actually originated inside the active map surface. */
export const isMapInteractionTarget = (target: EventTarget | null): boolean => {
  if (lastFrame === null || target === null) return false
  const mapCanvas = lastFrame.canvas
  const mapContainer = mapCanvas.parentElement
  if (target === mapCanvas || target === mapContainer) return true
  if (mapContainer === null) return false
  try {
    return mapContainer.contains(target as Node)
  } catch {
    return false
  }
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

/** Screen scale: how many CSS pixels one canvas pixel currently occupies. */
export const cssPixelsPerCanvasPixel = (): { x: number; y: number } => {
  return cssPixelsPerCanvasPixelIn(lastFrame)
}

/**
 * Fill one tile, to check alignment by eye.
 *
 * `__wts.mark(1082, 1673)` paints that tile solid and it should sit exactly on the tile wplace
 * drew, through any pan or zoom. Every alignment bug so far has been visible in one glance at this
 * and invisible in the numbers, so it stays in the shipped bundle behind the debug API.
 */
/** Draws every visible template over the tiles wplace is currently showing. */
const paintTemplates = (context: CanvasRenderingContext2D, frame: TileFrame): void => {
  const visible = localTemplates().filter((template) => template.visible)
  if (visible.length === 0) return

  let drawn = 0
  for (const quad of frame.quads) {
    const key = tileKey(quad.tile)
    // Match wplace's own texture filtering, measured off their GL calls: LINEAR when minifying,
    // NEAREST when magnifying. Pixel art must stay crisp past 100%, and must stop shimmering below
    // it — one setting cannot do both, which is why they switch and so do we.
    const magnifying = quad.width >= TILE_SIZE
    context.imageSmoothingEnabled = !magnifying
    if (!magnifying) context.imageSmoothingQuality = 'high'

    for (const template of visible) {
      const appearance = template.appearance ?? DEFAULT_APPEARANCE
      const preview = previewOriginFor(template.id)
      if (preview !== null && (preview.x !== template.originX || preview.y !== template.originY)) {
        const offsetX = preview.x - template.originX
        const offsetY = preview.y - template.originY
        const destinationLeft = quad.tile.x * TILE_SIZE
        const destinationTop = quad.tile.y * TILE_SIZE
        const sourceLeft = destinationLeft - offsetX
        const sourceTop = destinationTop - offsetY
        const firstSourceX = Math.floor(sourceLeft / TILE_SIZE)
        const lastSourceX = Math.floor((sourceLeft + TILE_SIZE - 1) / TILE_SIZE)
        const firstSourceY = Math.floor(sourceTop / TILE_SIZE)
        const lastSourceY = Math.floor((sourceTop + TILE_SIZE - 1) / TILE_SIZE)
        for (let sourceY = firstSourceY; sourceY <= lastSourceY; sourceY++) {
          for (let sourceX = firstSourceX; sourceX <= lastSourceX; sourceX++) {
            const sourceKey = `${sourceX}/${sourceY}`
            const tile = stampTile(template, sourceKey, appearance, quad.width)
            if (tile === undefined) continue
            const bitmap = levelFor(tile, quad.width)
            const targetLeft = sourceX * TILE_SIZE + offsetX
            const targetTop = sourceY * TILE_SIZE + offsetY
            const left = Math.max(destinationLeft, targetLeft)
            const top = Math.max(destinationTop, targetTop)
            const right = Math.min(destinationLeft + TILE_SIZE, targetLeft + TILE_SIZE)
            const bottom = Math.min(destinationTop + TILE_SIZE, targetTop + TILE_SIZE)
            if (right <= left || bottom <= top) continue
            const bitmapScaleX = bitmap.width / TILE_SIZE
            const bitmapScaleY = bitmap.height / TILE_SIZE
            context.globalAlpha = appearance.opacity
            context.drawImage(
              bitmap,
              (left - targetLeft) * bitmapScaleX,
              (top - targetTop) * bitmapScaleY,
              (right - left) * bitmapScaleX,
              (bottom - top) * bitmapScaleY,
              quad.x + ((left - destinationLeft) / TILE_SIZE) * quad.width,
              quad.y + ((top - destinationTop) / TILE_SIZE) * quad.height,
              ((right - left) / TILE_SIZE) * quad.width,
              ((bottom - top) / TILE_SIZE) * quad.height,
            )
            context.globalAlpha = 1
            drawn++
          }
        }
        continue
      }
      // Shape and colour filtering are baked into a stamped bitmap rather than applied per pixel
      // per frame; the stamp is rebuilt only when the appearance changes.
      const tile = stampTile(template, key, appearance, quad.width)
      if (tile === undefined) continue
      context.globalAlpha = appearance.opacity
      // Draw from the mip level nearest the on-screen size, so filtering never reduces by more
      // than 2x. One drawImage per tile per template, whatever the template's size.
      const bitmap = levelFor(tile, quad.width)
      // Use MapLibre's exact fractional quad. Snapping each quad independently changes both origin
      // and scale relative to the underlying WebGL tile, visibly distorting the internal pixel grid.
      context.drawImage(bitmap, quad.x, quad.y, quad.width, quad.height)
      context.globalAlpha = 1
      drawn++
    }
  }
  if (drawn > 0) log('draw', `painted ${drawn} template tiles`, { quads: frame.quads.length })
}

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
  try {
    installMapCapture()
  } catch {
    // Map capture is optional; URL-based navigation remains available without it.
  }
  try {
    installDebugApi({
      mark(x?: number, y?: number) {
        marked = x === undefined || y === undefined ? null : { x, y }
        repaint()
        if (marked === null) return '[wts] mark cleared'
        return `[wts] marking tile ${x},${y} — __wts.mark() with no arguments to clear`
      },
    })
  } catch {
    // Diagnostics are optional and must not prevent the render hooks from installing.
  }
  try {
    install()
  } catch {
    // Browser hooks are best-effort around page-owned surfaces.
  }
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  void restoreLocalTemplates()
  onPaint(paintTemplates)
  onPaint(paintMark)
  onTileFrame(draw)
  // A template appearing or moving has to repaint even if MapLibre is idle.
  onLocalChange(repaint)
  try {
    console.info(`[wts] loaded — tile size ${TILE_SIZE}`)
  } catch {
    // A replaced console is not part of the render path.
  }
}

main()
