import { log } from '../debug.js'
import { LAYER_ID as OVERLAY_LAYER } from '../gl/layer.js'
import { MARKER_LAYER_ID } from '../gl/markers.js'
import { getMap } from '../map-handle.js'
import { registerDraftCanvas } from '../tile-transform.js'

/**
 * wplace's draft layers, and where everything sits relative to them.
 *
 * A tile being painted gets its own MapLibre layer and image source, both named for the tile:
 *
 *     paint-preview-0.926838383211389-325,1783
 *
 * and the source hands back the 1000x1000 canvas the draft is drawn into. That canvas is where a
 * pixel placed and not yet submitted exists — blank apart from those pixels, measured at one painted
 * pixel in a million over a tile full of art — so it is the only way to know a mismatch has just
 * been fixed.
 *
 * Everything before this tried to recover the tile from where the texture landed on screen. It is
 * worth being explicit about how badly that went, because the answer was in the style the whole
 * time: it refused to name the layer whenever the camera had moved since the last raster draw, it
 * once matched the neighbouring tile and applied a placed pixel a thousand pixels away, and the
 * textures it was measuring turned out to be 0.125x and 0.063x the size of a tile — never draft
 * layers at all.
 *
 * ## The stack
 *
 * Draft layers come and go as tiles are painted, and each one is inserted wherever MapLibre is asked
 * to put it, so the order has to be maintained rather than set once:
 *
 * 1. wplace's tiles — what the server has
 * 2. wplace's own overlays — theirs to draw; ours is not a reason to suppress a feature of theirs
 * 3. **our overlays** — above their overlays, below anything about pixels being placed
 * 4. wplace's draft layer — a pixel waiting to be submitted covers the template it is completing,
 *    which is what makes placing one look like progress
 * 5. **our mismatch markers** — an annotation *about* a pixel cannot sit under that pixel, or the
 *    only way to watch a marker clear is to zoom out until the placed pixel is too small to hide it
 * 6. wplace's crosshair — always on top; it is the cursor
 */

/** Their id ends with the tile, which is the only part of it worth reading. */
const DRAFT_LAYER = /^paint-preview-.*-(\d+),(\d+)$/

/** Their crosshair, which stays above everything. */
const CROSSHAIR_LAYER = 'pixel-hover'

interface StyleLike {
  getStyle?: () => { layers?: Array<{ id: string; source?: string }> }
  getSource?: (id: string) => { getCanvas?: () => HTMLCanvasElement } | undefined
  getLayer?: (id: string) => unknown
  moveLayer?: (id: string, before?: string) => void
  on?: (event: string, listener: () => void) => void
}

/**
 * What the stack looked like last time it was arranged.
 *
 * Moving a layer fires `styledata`, which is what triggers this — so without a way to tell "already
 * arranged" from "needs arranging" it would move layers forever. The draft layers are the only part
 * that changes, so their names are the whole signature.
 */
let arrangedFor: string | null = null

/**
 * `styledata` fires far more often than layers change — every tile that loads, among other things —
 * and the first thing this does is `getStyle`, which serialises the entire style. Doing that dozens
 * of times a second is main-thread time spent to discover that nothing has changed.
 */
const THROTTLE_MS = 250
let lastLook = 0

const arrange = (): void => {
  const now = performance.now()
  if (now - lastLook < THROTTLE_MS) return
  lastLook = now
  const map = getMap() as StyleLike | null
  const layers = map?.getStyle?.().layers
  if (map === null || layers === undefined) return

  const drafts: string[] = []
  for (const layer of layers) {
    const match = DRAFT_LAYER.exec(layer.id)
    if (match === null) continue
    drafts.push(layer.id)
    const source = map.getSource?.(layer.source ?? layer.id)
    const canvas = source?.getCanvas?.()
    if (canvas === undefined) continue
    registerDraftCanvas(canvas, { x: Number(match[1]), y: Number(match[2]) })
  }

  const signature = drafts.join('|')
  if (signature === arrangedFor) return
  arrangedFor = signature

  const has = (id: string): boolean => map.getLayer?.(id) !== undefined
  const crosshair = has(CROSSHAIR_LAYER) ? CROSSHAIR_LAYER : undefined
  // Our overlay goes under the drafts, so a pixel waiting to be submitted covers the template it is
  // completing. With no drafts on the map there is nothing to be under but the crosshair.
  if (has(OVERLAY_LAYER)) map.moveLayer?.(OVERLAY_LAYER, drafts[0] ?? crosshair)
  // The markers go over them, and under the crosshair. Moved second so that with neither a draft nor
  // a crosshair to anchor to, "on top" still leaves the markers above the overlay.
  if (has(MARKER_LAYER_ID)) map.moveLayer?.(MARKER_LAYER_ID, crosshair)
  log('install', `arranged the stack around ${drafts.length} draft layers`)
}

export const watchDraftLayers = (): void => {
  const map = getMap() as StyleLike | null
  if (map === null) return
  // `styledata` fires when a layer is added or removed, which is exactly when a draft layer appears
  // or a tile stops being painted. Polling would mean serialising the style every frame.
  map.on?.('styledata', arrange)
  arrange()
}
