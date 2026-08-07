import type { TileCoord } from '@wts/shared'
import { getMap } from '../map-handle.js'

/**
 * Which pixels have been drafted, from wplace's own crosshair layer.
 *
 * The draft canvas cannot answer this. In their model a pixel's colour and its absence are the same
 * value — `pixels[i] = 0` is Transparent *and* is what an unpainted pixel holds — and the canvas
 * renders both at alpha zero. So a pixel drafted as transparent is byte-identical to one never
 * drafted at all, measured on the live page: a whole draft canvas with nothing above alpha 0 on it,
 * after deliberately drafting a transparent pixel.
 *
 * What distinguishes them is the crosshair. wplace draw one on every drafted pixel, from a custom
 * layer that keeps its own data:
 *
 *     map.style._layers['paint-crosshair-annotations'].implementation.tiles
 *       → Map("paint-crosshair-<patchX>,<patchY>" → { annotations: Uint8Array(40000), ... })
 *
 * 40,000 entries is a 200x200 patch, and a non-zero entry is a drafted pixel. Read against a live
 * page with two pixels drafted, the patch keyed `1626,8908` had exactly two non-zero entries, at
 * canvas (325269, 1781754) and (325204, 1781757) — the two that had been drafted.
 *
 * With this, all three states are readable: drafted to a colour, drafted to nothing, and not drafted.
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

/** Their patch key is the pixel coordinate divided by the patch size. */
const patchKey = (x: number, y: number): string =>
  `paint-crosshair-${Math.floor(x / PATCH)},${Math.floor(y / PATCH)}`

/**
 * A lookup for one tile, or null when nothing in it has been drafted.
 *
 * Gathered once per scan rather than per pixel: a tile spans twenty-five patches, and finding the
 * right one for every pixel of a million would be a string built and hashed a million times.
 */
export const draftedIn = (
  tile: TileCoord,
  tileSize: number,
): ((x: number, y: number) => boolean) | null => {
  const map = getMap() as CrosshairLayer | null
  const tiles = map?.style?._layers?.[CROSSHAIR_LAYER]?.implementation?.tiles
  if (tiles === undefined || tiles.size === 0) return null

  const across = tileSize / PATCH
  const patches: (Uint8Array | undefined)[] = []
  let any = false
  for (let row = 0; row < across; row++) {
    for (let column = 0; column < across; column++) {
      const key = patchKey(tile.x * tileSize + column * PATCH, tile.y * tileSize + row * PATCH)
      const annotations = tiles.get(key)?.annotations
      patches.push(annotations)
      if (annotations !== undefined) any = true
    }
  }
  if (!any) return null

  return (x: number, y: number): boolean => {
    const patch = patches[Math.floor(y / PATCH) * across + Math.floor(x / PATCH)]
    if (patch === undefined) return false
    return patch[(y % PATCH) * PATCH + (x % PATCH)] !== 0
  }
}
