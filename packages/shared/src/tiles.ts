/**
 * wplace serves the world canvas as PNG tiles from
 * `https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png`.
 *
 * Two properties of that endpoint shape everything downstream:
 *
 * - **The season is a runtime value**, not a constant. Hardcoding it means a season rollover
 *   silently stops every template from matching.
 * - **Unpainted tiles are a real HTTP 404.** Consumers branch on status, not on body content.
 */
export interface TileCoord {
  readonly x: number
  readonly y: number
}

/** Canonical `"x/y"` key used for tile lookup maps and sets. */
export type TileKey = `${number}/${number}`

export const tileKey = (t: TileCoord): TileKey => `${t.x}/${t.y}`

/**
 * Matched against each segment rather than parsing with `Number`, which accepts far too much:
 * `Number('')` is 0, so an empty segment would silently become tile 0, and `Number(' 1')` and
 * `Number('1e3')` both parse cleanly into coordinates nobody wrote.
 */
const INTEGER = /^-?\d+$/

export const parseTileKey = (key: string): TileCoord | null => {
  const parts = key.split('/')
  if (parts.length !== 2) return null

  const [x, y] = parts
  if (x === undefined || y === undefined) return null
  if (!INTEGER.test(x) || !INTEGER.test(y)) return null

  return { x: Number(x), y: Number(y) }
}

/** Edge length of a wplace canvas tile in pixels. Assumed, not yet verified — see recon ticket. */
export const TILE_SIZE = 1000
