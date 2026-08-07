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
  /** MapLibre's own layer order, ids in draw order. Custom layers are in it; `getStyle` omits them. */
  style?: { _order?: string[] }
  getStyle?: () => { layers?: Array<{ id: string; source?: string }> }
  getSource?: (id: string) => { getCanvas?: () => HTMLCanvasElement } | undefined
  getLayer?: (id: string) => unknown
  moveLayer?: (id: string, before?: string) => void
  on?: (event: string, listener: () => void) => void
}

/**
 * The order as MapLibre holds it, including our custom layers.
 *
 * `getStyle` serialises the whole style and leaves custom layers out of the result entirely, so it
 * can neither tell us where we are nor be called at this frequency. `_order` is a plain array of
 * ids; falling back to the serialised layers keeps this working if they ever rename it, at the cost
 * of not seeing ourselves.
 */
const orderOf = (map: StyleLike): readonly string[] =>
  map.style?._order ?? (map.getStyle?.().layers ?? []).map((layer) => layer.id)

const arrange = (): void => {
  const map = getMap() as StyleLike | null
  if (map === null) return
  const order = orderOf(map)
  if (order.length === 0) return

  const drafts: string[] = []
  for (const id of order) {
    const match = DRAFT_LAYER.exec(id)
    if (match === null) continue
    drafts.push(id)
    const canvas = map.getSource?.(id)?.getCanvas?.()
    if (canvas === undefined) continue
    registerDraftCanvas(canvas, { x: Number(match[1]), y: Number(match[2]) })
  }

  /**
   * Move only when the order is actually wrong.
   *
   * `moveLayer` is what causes the `styledata` that calls this, so a version that moved on every
   * pass would provoke itself forever — and if wplace re-insert a draft layer above ours, the two
   * would take turns rearranging the same stack for as long as the tab survived. Checking first
   * makes a settled stack cost an array scan and nothing else.
   */
  const at = (id: string): number => order.indexOf(id)
  const overlay = at(OVERLAY_LAYER)
  const markers = at(MARKER_LAYER_ID)
  const crosshair = at(CROSSHAIR_LAYER)
  const firstDraft = drafts.length === 0 ? -1 : at(drafts[0] as string)
  const lastDraft = drafts.length === 0 ? -1 : at(drafts[drafts.length - 1] as string)

  // The overlay belongs under the drafts, so a pixel waiting to be submitted covers the template it
  // is completing. With no drafts, under the crosshair is the only requirement.
  if (overlay >= 0 && firstDraft >= 0 && overlay > firstDraft) {
    map.moveLayer?.(OVERLAY_LAYER, drafts[0])
    log('install', 'moved the overlay back under the draft layers')
  }
  // The markers belong over the drafts and under the crosshair: an annotation about a pixel cannot
  // sit beneath that pixel.
  if (
    markers >= 0 &&
    ((lastDraft >= 0 && markers < lastDraft) || (crosshair >= 0 && markers > crosshair))
  ) {
    map.moveLayer?.(MARKER_LAYER_ID, crosshair >= 0 ? CROSSHAIR_LAYER : undefined)
    log('install', 'moved the markers above the draft layers')
  }
}

export const watchDraftLayers = (): void => {
  const map = getMap() as StyleLike | null
  if (map === null) return
  // `styledata` fires when a layer is added or removed, which is exactly when a draft layer appears
  // or a tile stops being painted. Polling would mean serialising the style every frame.
  map.on?.('styledata', arrange)
  arrange()
}
