import { TILE_SIZE, type TileCoord } from '@caelestis/shared'

/** The only two layers a colour pick is allowed to consult. */
export interface PickerSources {
  readonly template: number | null
  readonly pixelArt: number | null
}

/** Prefer the template overlay, then the real placed pixel. Nothing composited is an input. */
export const pickerIndex = ({ template, pixelArt }: PickerSources): number | null =>
  template ?? pixelArt

/** Exact placed colour at a canvas pixel, read from the uncomposited pixel-art tile cache. */
export const pixelArtIndexAt = (
  x: number,
  y: number,
  pixelsFor: (tile: TileCoord) => Uint8Array | null,
): number | null => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const column = Math.floor(x)
  const row = Math.floor(y)
  const tile = {
    x: Math.floor(column / TILE_SIZE),
    y: Math.floor(row / TILE_SIZE),
  }
  const pixels = pixelsFor(tile)
  if (pixels === null) return null
  const localX = column - tile.x * TILE_SIZE
  const localY = row - tile.y * TILE_SIZE
  const index = pixels[localY * TILE_SIZE + localX]
  return index === undefined || index === 255 ? null : index
}
