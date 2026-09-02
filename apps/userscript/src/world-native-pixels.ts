import { TILE_SIZE, type TileCoord } from '@caelestis/shared'
import type { NativePixelSnapshot } from './native-pixels.js'
import { draftPixels, tilePixels, UNPAINTED } from './tile-transform.js'

/** Adapt one captured world tile and its sparse native draft to the shared native-pixel contract. */
export const worldNativePixels = (tile: TileCoord): NativePixelSnapshot => {
  const x = tile.x * TILE_SIZE
  const y = tile.y * TILE_SIZE
  const committed = tilePixels(tile)
  const draft = draftPixels(tile)
  return {
    committed:
      committed === null
        ? []
        : [{ x, y, width: TILE_SIZE, height: TILE_SIZE, pixels: committed, emptyIndex: UNPAINTED }],
    draft:
      draft === null
        ? []
        : [{ x, y, width: TILE_SIZE, height: TILE_SIZE, pixels: draft, emptyIndex: UNPAINTED }],
  }
}
