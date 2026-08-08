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
import { getState, loadState, onStateChange, setState } from './state.js'
import {
  isTemplateVisible,
  localTemplates,
  onLocalChange,
  restoreLocalTemplates,
} from './templates/local-store.js'
import { onMismatchesChanged, wantsTilePixels } from './templates/mismatch.js'
import { installServerSync } from './templates/server-sync.js'
import {
  captureTilePixels,
  install,
  onTileFrame,
  reconcileDrafts,
  type TileFrame,
} from './tile-transform.js'
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

/**
 * Whether a keystroke belongs to something else on the page.
 *
 * A bare letter is only ours when nobody is typing and no modifier is held: `⌘S` is the browser's
 * and always will be, and a chat box or a template name must never lose a character to a shortcut.
 */
const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * The keyboard shortcuts, such as they are.
 *
 * Deliberately few and deliberately not on letters wplace already use. Scanned across all 150 of
 * their bundles, the only keys they compare against are MapLibre's own — arrows, `+`, `-`, `=`, `_`,
 * `0`, `r`/`R` — plus Escape, Enter and Space. `S` is free, and stays free of a modifier so it costs
 * nothing to reach mid-brushstroke.
 */
const installKeys = (): void => {
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isTyping(event.target)) return
    if (event.key !== 's' && event.key !== 'S') return
    event.preventDefault()
    setState({ onlySelectedColour: !getState().onlySelectedColour })
  })
}

const main = (): void => {
  // Before anything else: the trap has to be in place before MapLibre constructs its Map.
  step('map capture', installMapCapture)
  step('debug API', () => {
    installDebugApi({
      /** The captured MapLibre Map, for poking at its style and layers from the console. */
      map: () => getMap(),
      /** Each template's own switch beside the renderer's effective visibility decision. */
      templates: () =>
        localTemplates().map((template) => ({
          id: template.id,
          name: template.name,
          visible: template.visible,
          drawing: isTemplateVisible(template),
          folderId: template.folderId,
          server: template.serverUrl ?? null,
        })),
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
  /**
   * Settings and connected servers, before anything reads either.
   *
   * This used to happen as a side effect of the panel installing, which is late and in the wrong
   * place: everything before it — the appearance defaults, the colour filter, the list of servers to
   * fetch from — was reading the defaults instead of what was stored. Loading it here makes the rest
   * of this sequence mean what it says.
   */
  step('settings', () => void loadState())
  // Templates outlive a page load, which is what makes navigating to one survivable at all.
  step('local templates', () => void restoreLocalTemplates())
  // Server templates do not: they are re-fetched, because the server is where they live and a copy
  // kept here would outlive its deletion. Chunks are immutable and cached, so this is cheap.
  step('server templates', installServerSync)
  step('wplace account', () => void loadAccount())
  step('paint watcher', () => {
    watchPaintSelection()
    onPaintSelectionChange(repaint)
  })
  // Middle-click picking, answered from the template when the template is what you can see.
  step('colour picker', installColourPicker)
  step('keyboard shortcuts', installKeys)
  // Painting is not a map movement, so nothing would otherwise ask for the frame that shows a
  // marker going away.
  step('mismatch repaint', () => onMismatchesChanged(redraw))
  // wplace add a layer per tile being painted, above anything of ours added earlier, so a placed
  // pixel would otherwise cover the marker it just cleared.
  step('marker order', () => onFrame(keepMarkersAboveDrafts))
  // Drafting Transparent writes nothing a canvas hook can see, so the only place it shows up is
  // wplace's crosshairs. Throttled inside; with nothing drafted there is nothing to read.
  step('drafted pixels', () => onFrame(reconcileDrafts))
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
