import { TILE_SIZE } from '@wts/shared'
import {
  canvasPixelAtIn,
  cssPixelsPerCanvasPixelIn,
  screenPointForIn,
  viewportCentreIn,
} from './coordinates.js'
import { installDebugApi, warn } from './debug.js'
import { installOverlayLayer, setNudge } from './gl/layer.js'
import { keepMarkersAboveDrafts } from './gl/markers.js'
import { getMap, installMapCapture } from './map-handle.js'
import { onStateChange } from './state.js'
import { onLocalChange, restoreLocalTemplates } from './templates/local-store.js'
import { onMismatchesChanged, wantsTilePixels } from './templates/mismatch.js'
import { captureTilePixels, install, onTileFrame, type TileFrame } from './tile-transform.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { loadAccount } from './wplace-account.js'
import { onPaintSelectionChange, watchPaintSelection } from './wplace-paint.js'
import { installColourPicker } from './wplace-picker.js'

/**
 * Entry point.
 *
 * Templates are drawn by the GL layer, inside wplace's own canvas. There is no canvas of ours any
 * more: the 2D overlay this module used to own was the last remnant of rasterising into a surface
 * stacked over theirs, which is what every alignment bug came out of.
 *
 * What is left is bookkeeping. Each frame carries the rects wplace drew its tiles at, and those are
 * the only reference anything needs to turn a canvas pixel into a screen position or back — which is
 * how the per-overlay buttons follow their template and how an imported image lands where the view
 * is centred.
 */

let lastFrame: TileFrame | null = null

/** Run on every frame that carries tiles, after the frame has been recorded. */
export type FrameHook = (frame: TileFrame) => void

const hooks: FrameHook[] = []

/** Register something to run per frame, in registration order. */
export const onFrame = (hook: FrameHook): void => {
  hooks.push(hook)
}

/** Re-run the hooks against the last frame — for when our own state changed, not the map's. */
export const repaint = (): void => {
  if (lastFrame !== null) draw(lastFrame)
}

/**
 * Redraw everything after a change of ours: our coordinate-backed controls, and wplace's GL layer.
 */
export const redraw = (): void => {
  repaint()
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

/** Add the GL layer as soon as the captured map's style is ready. */
const attachOverlayLayer = (): void => {
  if (installOverlayLayer()) return
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    if (installOverlayLayer() || attempts > 60) clearInterval(timer)
  }, 250)
}

const draw = (frame: TileFrame): void => {
  // Keep the last frame that actually had tiles in it. Wplace emits empty frames while idle, but
  // coordinates and controls still need the last known tile projection until a new one arrives.
  if (frame.quads.length > 0) lastFrame = frame
  else if (lastFrame !== null) lastFrame = { canvas: frame.canvas, quads: lastFrame.quads }

  for (const hook of hooks) hook(frame)
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

/** Where a canvas pixel currently sits on screen, in client coordinates. */
export const screenPointFor = (x: number, y: number): { x: number; y: number } | null => {
  return lastFrame === null ? null : screenPointForIn(lastFrame, x, y)
}

/** Screen scale: how many CSS pixels one canvas pixel currently occupies. */
export const cssPixelsPerCanvasPixel = (): { x: number; y: number } => {
  return cssPixelsPerCanvasPixelIn(lastFrame)
}

/** Run one independent piece of start-up without letting its failure cancel the rest. */
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
    })
  })
  step('tile capture', install)
  step('local templates', () => void restoreLocalTemplates())
  step('wplace account', () => void loadAccount())
  step('paint watcher', () => {
    watchPaintSelection()
    onPaintSelectionChange(repaint)
  })
  // Middle-click picking, answered from the template when the template is what you can see.
  step('colour picker', installColourPicker)
  // Painting is not a map movement, so nothing would otherwise ask for the frame that shows a
  // marker going away.
  step('mismatch repaint', () => onMismatchesChanged(redraw))
  // wplace add a layer per tile being painted, above anything of ours added earlier, so a placed
  // pixel would otherwise cover the marker it just cleared.
  step('marker order', () => onFrame(keepMarkersAboveDrafts))
  /**
   * Start capturing before the first frame, not on it.
   *
   * A tile can only be caught as it is decoded, and the tiles filling the viewport on a page load
   * are decoded during the load — before any layer of ours has drawn. Deciding whether to capture at
   * draw time meant missing every one of them, and each then waited on wplace re-fetching it, which
   * is why a tile panned to answered in under a second while the ones already on screen took ten.
   */
  step('tile pixel capture', () => {
    const sync = (): void => captureTilePixels(wantsTilePixels())
    sync()
    onStateChange(sync)
    onLocalChange(sync)
    // And on every frame that carries tiles. The three above are the events that *should* cover it,
    // and between them they missed the only one that mattered: at start-up nothing is restored yet,
    // so the first call answers "nothing wants this" and the restore that follows does not
    // necessarily announce itself. Asking again per frame costs a comparison and cannot be wrong.
    onFrame(sync)
  })
  // Templates are drawn by the GL layer inside wplace's own canvas. Nothing of ours rasterises to a
  // canvas of its own any more; the tile frames are kept only as the coordinate reference that the
  // overlay controls and the import placement read.
  step('overlay layer', attachOverlayLayer)
  onFrame(() => renderOverlayControls(repaint))
  onTileFrame(draw)
  onLocalChange(redraw)
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
