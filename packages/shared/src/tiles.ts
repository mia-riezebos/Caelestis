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

export const parseTileKey = (key: string): TileCoord | null => {
  const [x, y] = key.split('/')
  if (x === undefined || y === undefined) return null
  const cx = Number(x)
  const cy = Number(y)
  return Number.isInteger(cx) && Number.isInteger(cy) ? { x: cx, y: cy } : null
}

/** Edge length of a wplace canvas tile in pixels. Assumed, not yet verified — see recon ticket. */
export const TILE_SIZE = 1000
