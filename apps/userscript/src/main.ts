import { TILE_SIZE } from '@caelestis/shared'
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { installAlarmNotifications } from './alarms.js'
import { installAllianceServerSync, selectedAllianceManifestScope } from './alliance-server-sync.js'
import { activeAllianceSurface, installAllianceSurfaceObserver } from './alliance-surface.js'
import {
  canvasPixelAtIn,
  createScreenProjectionCache,
  cssPixelsPerCanvasPixelIn,
  type ScreenProjection,
  screenPointForIn,
  viewportCentreIn,
} from './coordinates.js'
import { installDebugApi, warn } from './debug.js'
import { installAllianceOverlayLayer, repaintAllianceOverlayLayer } from './gl/artboard-layer.js'
import {
  installOverlayLayer,
  overlayGpuMemoryBytes,
  overlayStagingMemoryBytes,
  setNudge,
} from './gl/layer.js'
import {
  keepMarkersAboveDrafts,
  markerBatchMemoryBytes,
  markerDensityMemoryBytes,
  markerGpuMemoryBytes,
} from './gl/markers.js'
import { installKeyboardShortcuts } from './keyboard-shortcuts.js'
import { getMap, installMapCapture, releaseMapCapture } from './map-handle.js'
import {
  installPaintPaletteProgress,
  paintPaletteProgress,
  refreshPaintPaletteFocus,
} from './paint-palette.js'
import {
  installProfile,
  measureProfile,
  profileReport,
  profileSnapshot,
  registerProfileMemorySource,
  resetProfile,
} from './profile.js'
import { serverMismatchMemoryBytes } from './server-mismatch.js'
import { getState, loadState, onStateChange } from './state.js'
import { installTelemetry } from './telemetry.js'
import {
  isTemplateVisible,
  localTemplates,
  onLocalChange,
  onLocalPreviewChange,
  restoreLocalTemplates,
  templateIndexMemoryBytes,
} from './templates/local-store.js'
import { pixelAccounting } from './templates/mismatch.js'
import { mismatchWorkerMemoryBytes } from './templates/mismatch-worker.js'
import { installServerSync } from './templates/server-sync.js'
import {
  capturedPixelMemoryBytes,
  captureTilePixels,
  clearDraftPixels,
  install,
  onTileFrame,
  reconcileDrafts,
  type TileFrame,
} from './tile-transform.js'
import { renderOverlayControls } from './ui/overlay-menu.js'
import { installPanel } from './ui/panel.js'
import { loadAccount } from './wplace-account.js'
import { isPaintOpen, onPaintSelectionChange, watchPaintSelection } from './wplace-paint.js'
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

interface RegisteredFrameHook {
  readonly hook: FrameHook
  readonly name: string
}

const hooks: RegisteredFrameHook[] = []

/** Register something to run per frame, in registration order. */
export const onFrame = (hook: FrameHook, name = 'Frame hook'): void => {
  hooks.push({ hook, name })
}

/** Re-run the hooks against the last frame — for when our own state changed, not the map's. */
export const repaint = (): void => {
  if (lastFrame !== null) draw(lastFrame)
}

/** Ask MapLibre to repaint custom GL layers without rerunning screen-space controls immediately. */
const repaintMap = (): void => {
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

/**
 * Redraw everything after a change of ours: our coordinate-backed controls, and wplace's GL layer.
 */
export const redraw = (): void => {
  repaint()
  repaintMap()
  repaintAllianceOverlayLayer()
}

/** Keep the GL layer attached across delayed map creation, style reloads, and SPA map replacement. */
const attachOverlayLayer = (): void => {
  const attach = (): void => {
    const map = getMap()
    if (map !== null) {
      try {
        if (!map.getCanvas().isConnected) releaseMapCapture()
      } catch {
        releaseMapCapture()
      }
    }
    if (getMap() === null) installMapCapture()
    installOverlayLayer()
  }
  attach()
  setInterval(attach, 1_000)
}

/** A draw is on the stack; synchronous repaint requests become a later pass, never recursion. */
let drawing = false
let drawAgain = false
const MAX_DRAW_PASSES = 3

const draw = (frame: TileFrame): void => {
  if (drawing) {
    drawAgain = true
    return
  }
  drawing = true
  try {
    let passes = 0
    do {
      drawAgain = false
      paintOnce(frame)
      passes++
    } while (drawAgain && passes < MAX_DRAW_PASSES)
  } finally {
    drawing = false
    drawAgain = false
  }
}

const paintOnce = (frame: TileFrame): void => {
  lastFrame = frame

  for (const { hook, name } of hooks) {
    try {
      measureProfile(name, () => hook(frame))
    } catch (error) {
      warn('install', 'frame hook failed', String(error))
    }
  }
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

/** One cached canvas-layout measurement shared by every map-following control. */
const overlayProjection = createScreenProjectionCache()
export const screenProjection = (): ScreenProjection | null => overlayProjection.project(lastFrame)

/** Run one independent piece of start-up without letting its failure cancel the rest. */
const step = (what: string, run: () => void): void => {
  try {
    run()
  } catch (error) {
    warn('install', `${what} failed to start`, String(error))
  }
}

const main = (): void => {
  step('shared UI', registerCaelestisUi)
  step('performance profile', installProfile)
  registerProfileMemorySource('Template pixels', templateIndexMemoryBytes)
  registerProfileMemorySource('Captured tile pixels', capturedPixelMemoryBytes)
  registerProfileMemorySource('Mismatch cache', pixelAccounting.memoryBytes)
  registerProfileMemorySource('Server mismatch masks', serverMismatchMemoryBytes)
  registerProfileMemorySource('Mismatch worker copy', mismatchWorkerMemoryBytes)
  registerProfileMemorySource('Overlay GPU buffers', overlayGpuMemoryBytes)
  registerProfileMemorySource('Overlay index staging', overlayStagingMemoryBytes)
  registerProfileMemorySource('Marker density buffers', markerDensityMemoryBytes)
  registerProfileMemorySource('Marker draw batches', markerBatchMemoryBytes)
  registerProfileMemorySource('Marker GPU buffers', markerGpuMemoryBytes)
  // Before anything else: the trap has to be in place before MapLibre constructs its Map.
  step('map capture', installMapCapture)
  step('alliance surface observer', installAllianceSurfaceObserver)
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
          serverTemplateId: template.serverTemplateId ?? null,
          opaque: template.opaque,
        })),
      /** The active Wplace artboard and exact backend manifest scope selected for it. */
      allianceSurface: () => ({
        active: activeAllianceSurface()?.surface ?? null,
        manifest: selectedAllianceManifestScope(),
        servers: getState().servers.map((server) => ({
          url: server.url,
          status: server.status,
          identified: server.info !== null,
          season: server.season,
        })),
      }),
      /** The exact focused-template counts currently decorating Wplace's native paint palette. */
      paletteProgress: () => paintPaletteProgress(),
      /** A live performance snapshot. Enable profiling in Settings first. */
      profile: () => profileSnapshot(),
      /** Clear the current sample window without disabling profiling. */
      profileReset: () => {
        resetProfile()
        return profileSnapshot()
      },
      /** Copyable JSON for comparing a Caelestis run with a clean Wplace run. */
      profileReport: () => profileReport(),
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
        return `[caelestis] overlay nudged by ${applied.x}, ${applied.y} canvas px — __caelestis.nudge() to clear`
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
  step('alliance server templates', installAllianceServerSync)
  step('server telemetry', installTelemetry)
  step('alarm notifications', installAlarmNotifications)
  step('wplace account', () => void loadAccount())
  step('paint watcher', () => {
    watchPaintSelection()
    // The selected-colour marker lives in MapLibre's custom layer. Returning from Eraser to Pencil
    // changes the selected swatch without moving the map, so repainting only the retained
    // screen-space frame leaves that marker stale until some unrelated map animation happens.
    onPaintSelectionChange(() => {
      if (!isPaintOpen()) clearDraftPixels()
      redraw()
    })
  })
  step('paint palette progress', installPaintPaletteProgress)
  onFrame(refreshPaintPaletteFocus, 'Paint palette focus')
  // Middle-click picking, answered from the template when the template is what you can see.
  step('colour picker', installColourPicker)
  step('keyboard shortcuts', () => {
    installKeyboardShortcuts(redraw)
  })
  // Painting is not a map movement, so nothing would otherwise ask for the frame that shows a
  // marker going away.
  // A completed scan changes marker buffers and progress only. Progress has its own DOM listeners;
  // rerunning every screen-space overlay control here duplicates the MapLibre frame requested next.
  step('mismatch repaint', () => pixelAccounting.onChange(repaintMap))
  // wplace add a layer per tile being painted, above anything of ours added earlier, so a placed
  // pixel would otherwise cover the marker it just cleared.
  step('marker order', () => onFrame(keepMarkersAboveDrafts, 'Keep marker layer above drafts'))
  // Drafting Transparent writes nothing a canvas hook can see, so the only place it shows up is
  // wplace's crosshairs. Throttled inside; with nothing drafted there is nothing to read.
  step('drafted pixels', () => onFrame(reconcileDrafts, 'Reconcile drafted pixels'))
  /**
   * Start capturing before the first frame, not on it.
   *
   * A tile can only be caught as it is decoded, and the tiles filling the viewport on a page load
   * are decoded during the load — before any layer of ours has drawn. Deciding whether to capture at
   * draw time meant missing every one of them, and each then waited on wplace re-fetching it, which
   * is why a tile panned to answered in under a second while the ones already on screen took ten.
   */
  step('tile pixel capture', () => {
    // The pipette fallback reads the exact pixel-art tile, so Paint itself is a pixel consumer even
    // when mismatch markers are off. Starting at drawer-open gives visible tiles time to populate
    // before the one-shot picker click; a miss is also chased on demand by `placedIndexAt`.
    const interest = (tile: { readonly x: number; readonly y: number }): boolean =>
      isPaintOpen() || pixelAccounting.wantsTilePixels(tile)
    const sync = (): void =>
      captureTilePixels(pixelAccounting.wantsTilePixels() || isPaintOpen(), interest)
    sync()
    onStateChange(sync)
    onLocalChange(sync)
    onPaintSelectionChange(sync)
    // And on every frame that carries tiles. The four above are the events that *should* cover it,
    // and between them they missed the only one that mattered: at start-up nothing is restored yet,
    // so the first call answers "nothing wants this" and the restore that follows does not
    // necessarily announce itself. Asking again per frame costs a comparison and cannot be wrong.
    onFrame(sync, 'Tile pixel capture state')
  })
  // Templates are drawn by the GL layer inside wplace's own canvas. Nothing of ours rasterises to a
  // canvas of its own any more; the tile frames are kept only as the coordinate reference that the
  // overlay controls and the import placement read.
  step('overlay layer', attachOverlayLayer)
  step('alliance overlay layer', installAllianceOverlayLayer)
  onFrame((frame) => renderOverlayControls(repaint, frame.canvas), 'Overlay controls')
  onTileFrame(draw)
  onLocalChange(redraw)
  onLocalPreviewChange(redraw)
  onStateChange(redraw)
  step('panel', () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installPanel, { once: true })
    } else {
      installPanel()
    }
  })
  try {
    console.info(`[caelestis] loaded — tile size ${TILE_SIZE}`)
  } catch {
    // A replaced console is not part of the render path.
  }
}

main()
