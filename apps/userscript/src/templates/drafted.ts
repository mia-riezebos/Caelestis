import type { TileCoord } from '@wts/shared'
import { getMap } from '../map-handle.js'

/**
 * Which pixels have been drafted, from wplace's own crosshair layer.
 *
 * The draft canvas cannot answer this. In their model a pixel's colour and its absence are the same
 * value — index 0 is Transparent *and* is what an unpainted pixel holds — and the canvas renders
 * both at alpha zero. So a pixel drafted as transparent is byte-identical to one never drafted at
 * all, measured on the live page: a whole draft canvas with nothing above alpha 0 on it, after
 * deliberately drafting a transparent pixel.
 *
 * What distinguishes them is the crosshair. wplace draw one on every drafted pixel, from a custom
 * layer that keeps its own data:
 *
 *     map.style._layers['paint-crosshair-annotations'].implementation.tiles
 *       → Map("paint-crosshair-<patchX>,<patchY>" → { annotations: Uint8Array(40000), ... })
 *
 * 40,000 entries is a 200x200 patch, and a non-zero entry is a drafted pixel. Read against a live
 * page with two pixels drafted, the patch keyed `1626,8908` held exactly two non-zero entries, at
 * canvas (325269, 1781754) and (325204, 1781757) — the two that had been drafted.
 *
 * Enumerated rather than asked per pixel. Only drafted pixels are interesting and there are rarely
 * many, so this costs the number of answers rather than the size of a tile — and a patch only
 * exists where something has been drafted, so the empty case reads nothing at all.
 */

/** wplace's crosshair patches are this many pixels a side. */
const PATCH = 200

/** Their layer, and the field on it that holds the patches. */
const CROSSHAIR_LAYER = 'paint-crosshair-annotations'

interface CrosshairLayer {
  style?: {
    _layers?: Record<
      string,
      { implementation?: { tiles?: Map<string, { annotations?: Uint8Array }> } }
    >
  }
}

/**
 * Every drafted pixel in one tile, as tile-local `y * tileSize + x`.
 *
 * Empty when nothing in the tile is drafted, and equally when their layer is not there to ask —
 * they only add it while a draft exists, so its absence and an empty draft mean the same.
 */
export const draftedPixelsIn = (tile: TileCoord, tileSize: number): number[] => {
  const map = getMap() as CrosshairLayer | null
  const tiles = map?.style?._layers?.[CROSSHAIR_LAYER]?.implementation?.tiles
  if (tiles === undefined || tiles.size === 0) return []

  const found: number[] = []
  const across = tileSize / PATCH
  const firstPatchX = (tile.x * tileSize) / PATCH
  const firstPatchY = (tile.y * tileSize) / PATCH
  for (let row = 0; row < across; row++) {
    for (let column = 0; column < across; column++) {
      const annotations = tiles.get(
        `paint-crosshair-${firstPatchX + column},${firstPatchY + row}`,
      )?.annotations
      if (annotations === undefined) continue
      const offsetX = column * PATCH
      const offsetY = row * PATCH
      for (let i = 0; i < annotations.length; i++) {
        if (annotations[i] === 0) continue
        found.push((offsetY + Math.floor(i / PATCH)) * tileSize + offsetX + (i % PATCH))
      }
    }
  }
  return found
}
