import { TILE_SIZE, tileKey } from '@wts/shared'
import {
  canvasPixelAtIn,
  cssPixelsPerCanvasPixelIn,
  screenPointForIn,
  viewportCentreIn,
} from './coordinates.js'
import { installDebugApi, log, warn } from './debug.js'
import { installOverlayLayer, setNudge } from './gl/layer.js'
import { getMap, installMapCapture } from './map-handle.js'
import { type FramePainter, paintFrame } from './paint.js'
import { onStateChange } from './state.js'
import { type Appearance, MIN_CELL_FOR_SHAPE, stampMask } from './templates/appearance.js'
import { effectiveHiddenColours } from './templates/colour-filter.js'
import {
  appearanceOf,
  isTemplateVisible,
  levelFor,
  localTemplates,
  onLocalChange,
  previewOriginFor,
  restoreLocalTemplates,
  stampTile,
} from './templates/local-store.js'
import { install, onTileFrame, type TileFrame } from './tile-transform.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { loadAccount } from './wplace-account.js'
import { onPaintSelectionChange, watchPaintSelection } from './wplace-paint.js'

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

/**
 * Redraw everything after a change of ours: our own canvas, and wplace's.
 *
 * The templates now live in a layer inside *their* canvas, which only renders when MapLibre decides
 * to. Hiding a folder or moving a slider is not something MapLibre knows about, so it has to be
 * asked — otherwise the change waits for the next pan.
 */
export const redraw = (): void => {
  repaint()
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

/**
 * Add the GL layer as soon as the map exists.
 *
 * The map is captured while MapLibre constructs it, but its style is not ready at that moment, and
 * `addLayer` before the style loads throws. Retrying briefly is simpler than reaching for a
 * MapLibre event whose name differs across versions.
 */
const attachOverlayLayer = (): void => {
  if (installOverlayLayer()) return
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    if (installOverlayLayer() || attempts > 60) clearInterval(timer)
  }, 250)
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
 * One reusable scratch surface for the masking pass.
 *
 * Allocated once and grown as needed rather than per tile per frame, because a canvas allocation is
 * a GPU surface allocation and doing six of those every frame is its own performance problem.
 */
let scratch: OffscreenCanvas | null = null

/**
 * The tile with the pixel shape cut out of it, or null if it should be drawn as-is.
 *
 * Two `drawImage`s and one `fillRect` per tile, at screen resolution — replacing a per-pixel path
 * loop over a million pixels. The mask is a repeating pattern of a single cell, scaled to whatever a
 * cell measures on screen, so the shape stays smooth at any zoom instead of being quantised to a 3x3
 * block. `destination-in` keeps the tile's colour only where the stamp is opaque.
 *
 * The pattern's origin is the tile's top-left corner, which is also cell (0,0) of that tile, so the
 * repeat lines up with the pixel grid without any phase correction.
 */
const drawMasked = (
  destination: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  appearance: Appearance,
  tile: { left: number; top: number; width: number; height: number },
): boolean => {
  const cellPixels = tile.width / TILE_SIZE
  // Too small for a shape to read, so skip the whole pass — this is also the common case while
  // zoomed out, and it is the difference between panning smoothly and not.
  if (cellPixels < MIN_CELL_FOR_SHAPE) return false
  const mask = stampMask(appearance)
  if (mask === null) return false

  // Only the part of the tile that is actually on screen.
  //
  // Sizing the scratch to the whole tile is wrong by orders of magnitude once zoomed in: at z17 a
  // tile spans about 90,000 device pixels, so the allocation failed, `getContext` returned null and
  // the overlay silently fell back to drawing unmasked — shapes just stopped appearing past a
  // certain zoom. Clipping to the viewport bounds the work by what can be seen instead.
  const left = Math.max(tile.left, 0)
  const top = Math.max(tile.top, 0)
  const right = Math.min(tile.left + tile.width, destination.canvas.width)
  const bottom = Math.min(tile.top + tile.height, destination.canvas.height)
  const width = Math.ceil(right - left)
  const height = Math.ceil(bottom - top)
  if (width <= 0 || height <= 0) return true

  if (scratch === null || scratch.width < width || scratch.height < height) {
    scratch = new OffscreenCanvas(
      Math.max(width, scratch?.width ?? 0),
      Math.max(height, scratch?.height ?? 0),
    )
  }
  const context = scratch.getContext('2d')
  if (context === null) return false

  // The scratch origin is the visible corner, so everything below is offset by how much of the tile
  // is off-screen above and to the left.
  const offsetX = tile.left - left
  const offsetY = tile.top - top

  context.clearRect(0, 0, width, height)
  context.globalCompositeOperation = 'source-over'
  // Nearest: we are magnifying, and a template pixel must stay a crisp square before it is carved.
  context.imageSmoothingEnabled = false
  context.drawImage(bitmap, offsetX, offsetY, tile.width, tile.height)

  const pattern = context.createPattern(mask, 'repeat')
  if (pattern === null) return false
  // Scale one mask to one cell, then shift by the same off-screen offset, so the repeat stays keyed
  // to the tile's own pixel grid rather than to whatever corner happens to be visible.
  pattern.setTransform(new DOMMatrix().translate(offsetX, offsetY).scale(cellPixels / mask.width))
  context.globalCompositeOperation = 'destination-in'
  context.fillStyle = pattern
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'source-over'

  destination.drawImage(scratch, 0, 0, width, height, left, top, width, height)
  return true
}

/** Draws every visible template over the tiles wplace is currently showing. */
const paintTemplates = (context: CanvasRenderingContext2D, frame: TileFrame): void => {
  const visible = localTemplates().filter(isTemplateVisible)
  if (visible.length === 0) return

  let drawn = 0
  let smoothing: boolean | null = null
  for (const quad of frame.quads) {
    const key = tileKey(quad.tile)
    for (const template of visible) {
      const own = appearanceOf(template)
      // The global colour switches and this overlay's own switches, joined. Without this the
      // settings grid wrote a value nothing ever read.
      const hiddenColours = effectiveHiddenColours(own.hiddenColours)
      const appearance = hiddenColours === own.hiddenColours ? own : { ...own, hiddenColours }
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
            const minifying = bitmap.width > quad.width || bitmap.height > quad.height
            if (smoothing !== minifying) {
              smoothing = minifying
              context.imageSmoothingEnabled = minifying
              if (minifying) context.imageSmoothingQuality = 'high'
            }
            context.globalAlpha = appearance.opacity
            const canvasLeft =
              quad.x + ((targetLeft - destinationLeft) / TILE_SIZE) * quad.width
            const canvasTop = quad.y + ((targetTop - destinationTop) / TILE_SIZE) * quad.height
            context.save()
            context.beginPath()
            context.rect(quad.x, quad.y, quad.width, quad.height)
            context.clip()
            if (
              !drawMasked(context, bitmap, appearance, {
                left: canvasLeft,
                top: canvasTop,
                width: quad.width,
                height: quad.height,
              })
            ) {
              context.drawImage(bitmap, canvasLeft, canvasTop, quad.width, quad.height)
            }
            context.restore()
            context.globalAlpha = 1
            drawn++
          }
        }
        continue
      }
      // Only the colour filter is baked. Shape is applied below, as a mask at screen resolution.
      const tile = stampTile(template, key, appearance)
      if (tile === undefined) continue
      context.globalAlpha = appearance.opacity
      // Draw from the mip level nearest the on-screen size, so filtering never reduces by more
      // than 2x. One drawImage per tile per template, whatever the template's size.
      const bitmap = levelFor(tile, quad.width)
      // Match wplace's texture filtering against the actual selected source level. Stamped tiles
      // need not be TILE_SIZE wide, so comparing only the destination to TILE_SIZE can classify a
      // real minification as magnification and drop source rows/columns.
      const minifying = bitmap.width > quad.width || bitmap.height > quad.height
      if (smoothing !== minifying) {
        smoothing = minifying
        context.imageSmoothingEnabled = minifying
        if (minifying) context.imageSmoothingQuality = 'high'
      }
      // Use MapLibre's exact fractional quad. Snapping each quad independently changes both origin
      // and scale relative to the underlying WebGL tile, visibly distorting the internal pixel grid.
      if (
        !drawMasked(context, bitmap, appearance, {
          left: quad.x,
          top: quad.y,
          width: quad.width,
          height: quad.height,
        })
      ) {
        context.drawImage(bitmap, quad.x, quad.y, quad.width, quad.height)
      }
      context.globalAlpha = 1
      drawn++
    }
  }
  if (drawn > 0) log('draw', `painted ${drawn} template tiles`, { quads: frame.quads.length })
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

/**
 * Run one piece of start-up, and let the rest start even if it fails.
 *
 * `main` is a straight sequence of installs, so a throw in any one of them silently cancels every
 * install after it. That is how a null-argument `MutationObserver` in the paint watcher removed the
 * rail button: an unrelated subsystem three lines earlier, no error visible in the UI, and nothing
 * to suggest where to look.
 *
 * Failing loudly and continuing is strictly better here. Every one of these is independent, and a
 * page missing one feature beats a page missing all of them.
 */
const step = (what: string, run: () => void): void => {
  try {
    run()
  } catch (error) {
    warn('install', `${what} failed to start`, String(error))
  }
}

const main = (): void => {
  // Before anything else: the trap has to be in place before MapLibre constructs its Map.
  step('map capture', installMapCapture)
  step('debug API', () => {
    installDebugApi({
      /** The captured MapLibre Map, for poking at its style and layers from the console. */
      map: () => getMap(),
      /** The tiles wplace drew on the last frame, and where. How much work a frame actually is. */
      quads: () =>
        lastFrame === null
          ? null
          : {
              count: lastFrame.quads.length,
              canvas: `${lastFrame.canvas.width}x${lastFrame.canvas.height}`,
              cellPixels: (lastFrame.quads[0]?.width ?? 0) / TILE_SIZE,
              tiles: lastFrame.quads.map((quad) => `${quad.tile.x}/${quad.tile.y}`),
            },
      /** Shift every template by fractional canvas pixels for alignment diagnostics. */
      nudge(x = 0, y = 0) {
        const applied = setNudge(x, y)
        redraw()
        return `[wts] overlay nudged by ${applied.x}, ${applied.y} canvas px — __wts.nudge() to clear`
      },
      mark(x?: number, y?: number) {
        marked = x === undefined || y === undefined ? null : { x, y }
        repaint()
        if (marked === null) return '[wts] mark cleared'
        return `[wts] marking tile ${x},${y} — __wts.mark() with no arguments to clear`
      },
    })
  })
  step('tile capture', install)
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  step('local templates', () => void restoreLocalTemplates())
  step('wplace account', () => void loadAccount())
  // "Only the selected colour" needs to know when wplace's drawer opens and what is picked in it.
  step('paint watcher', () => {
    watchPaintSelection()
    onPaintSelectionChange(repaint)
  })
  // Templates are drawn by the GL layer inside wplace's own canvas. Our 2D canvas is now only the
  // debug marker and the positioning reference the overlay controls read.
  step('overlay layer', attachOverlayLayer)
  // The buttons ride with the overlay, so they are repositioned on the same frame the map moved.
  onPaint(() => renderOverlayControls(repaint))
  onPaint(paintMark)
  onTileFrame(draw)
  // A template appearing or moving has to repaint even if MapLibre is idle.
  onLocalChange(redraw)
  // So does anything in settings that changes what is drawn: the global colour filter, the global
  // appearance, and a folder being hidden. Without this the canvas only caught up on the next frame
  // MapLibre happened to produce, so toggling something and not touching the map looked broken.
  onStateChange(redraw)
  step('panel', () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installPanel, { once: true })
    } else {
      installPanel()
    }
  })
  try {
    console.info(`[wts] loaded — tile size ${TILE_SIZE}`)
  } catch {
    // A replaced console is not part of the render path.
  }
}

main()
