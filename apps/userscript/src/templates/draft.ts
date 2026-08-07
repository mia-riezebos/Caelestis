import type { TileCoord } from '@wts/shared'
import { log } from '../debug.js'
import { getMap } from '../map-handle.js'
import { registerDraftCanvas } from '../tile-transform.js'

/**
 * wplace's draft layers, found by asking the map rather than by watching the GPU.
 *
 * A tile being painted gets its own MapLibre layer and image source, both named for the tile:
 *
 *     paint-preview-0.926838383211389-325,1783
 *
 * and the source hands back the 1000x1000 canvas the draft is drawn into. That canvas is where a
 * pixel placed and not yet submitted exists — it is blank apart from those pixels, measured at one
 * painted pixel in a million over a tile full of art — so it is the only way to know that a
 * mismatch has just been fixed.
 *
 * Everything before this tried to recover the tile from where the texture landed on screen. It is
 * worth being clear about how badly that went, because the answer was in the style the whole time:
 * it refused to name the layer whenever the camera had moved since the last raster draw, it once
 * matched the neighbouring tile and applied a placed pixel a thousand pixels away, and the textures
 * it was measuring turned out to be 0.125x and 0.063x the size of a tile — never draft layers at
 * all.
 */

/** Their id ends with the tile, which is the only part of it worth reading. */
const DRAFT_LAYER = /^paint-preview-.*-(\d+),(\d+)$/

/** Their marker layer. Ours has to stay directly below it and above everything else. */
const CROSSHAIR_LAYER = 'pixel-hover'

interface StyleLike {
  getStyle?: () => { layers?: Array<{ id: string; source?: string }> }
  getSource?: (id: string) => { getCanvas?: () => HTMLCanvasElement } | undefined
  getLayer?: (id: string) => unknown
  moveLayer?: (id: string, before?: string) => void
  on?: (event: string, listener: () => void) => void
}

/**
 * Point every draft canvas at its tile, and keep the markers above them.
 *
 * The move is the second half of the same problem. A draft layer is added when painting starts, and
 * MapLibre puts it wherever it is asked to — which lands it *above* a layer of ours added earlier.
 * The pixel just placed then covers the marker it was meant to clear, so the only way to see the
 * marker go was to zoom out until the placed pixel was too small to hide it.
 */
const sync = (markerLayerId: string): void => {
  const map = getMap() as StyleLike | null
  const layers = map?.getStyle?.().layers
  if (map === null || layers === undefined) return

  let drafts = 0
  for (const layer of layers) {
    const match = DRAFT_LAYER.exec(layer.id)
    if (match === null) continue
    drafts++
    const source = map.getSource?.(layer.source ?? layer.id)
    const canvas = source?.getCanvas?.()
    if (canvas === undefined) continue
    const tile: TileCoord = { x: Number(match[1]), y: Number(match[2]) }
    registerDraftCanvas(canvas, tile)
  }

  // Only worth doing while there is something to be above, and only when ours is not already last
  // before their crosshair.
  if (drafts === 0) return
  if (map.getLayer?.(markerLayerId) === undefined) return
  map.moveLayer?.(
    markerLayerId,
    map.getLayer?.(CROSSHAIR_LAYER) === undefined ? undefined : CROSSHAIR_LAYER,
  )
  log('install', `draft layers: ${drafts}, markers moved above them`)
}

export const watchDraftLayers = (markerLayerId: string): void => {
  const map = getMap() as StyleLike | null
  if (map === null) return
  const run = (): void => sync(markerLayerId)
  // `styledata` is what fires when a layer is added or removed, which is exactly when a draft layer
  // appears. Polling the style every frame would mean serialising it every frame.
  map.on?.('styledata', run)
  run()
}
