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

export interface LatLng {
  readonly lat: number
  readonly lng: number
}

export interface CanvasPixel {
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
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/

export const parseTileKey = (key: string): TileCoord | null => {
  const parts = key.split('/')
  if (parts.length !== 2) return null

  const [x, y] = parts
  if (x === undefined || y === undefined) return null
  if (!CANONICAL_NON_NEGATIVE_INTEGER.test(x) || !CANONICAL_NON_NEGATIVE_INTEGER.test(y))
    return null

  const tile = { x: Number(x), y: Number(y) }
  if (tile.x >= WORLD_TILES || tile.y >= WORLD_TILES) return null
  return tile
}

/** Web Mercator zoom used by the wplace canvas. */
export const CANVAS_ZOOM = 11

/** Edge length of a wplace canvas tile in pixels. */
export const TILE_SIZE = 1000

/** Number of tiles on each edge of the world canvas. */
export const WORLD_TILES = 2 ** CANVAS_ZOOM

/** Number of pixels on each edge of the world canvas. */
export const WORLD_PIXELS = WORLD_TILES * TILE_SIZE

const DEGREES_PER_RADIAN = 180 / Math.PI
const RADIANS_PER_DEGREE = Math.PI / 180

/**
 * The latitude at which a Web Mercator projection becomes square, and therefore the edge of the
 * canvas. Nothing exists above it to map to: the projection sends the poles to infinity.
 */
export const MAX_MERCATOR_LATITUDE = 85.05112877980659

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/**
 * Longitude wraps rather than clamps, because the canvas does: x = 0 and x = WORLD_PIXELS are the
 * same meridian. Clamping put `lng: 180` at exactly WORLD_PIXELS, which floors to tile 2048 — one
 * past the last tile, and rejected by `parseTileKey`.
 */
const wrapUnitInterval = (value: number): number => ((value % 1) + 1) % 1

/**
 * Convert latitude/longitude to fractional global canvas-pixel coordinates.
 *
 * Latitude is clamped to the Mercator limit because the projection has no answer beyond it — `±90`
 * produces `±Infinity` and anything past a pole produces `NaN`, either of which would flow into a
 * bounding box and then into tile arithmetic. Clamping is the projection's own semantics, not a
 * guess: the canvas simply does not extend past that parallel.
 *
 * This is deliberately not validation. A caller handing over an out-of-range latitude has a bug
 * worth surfacing, and the place to reject it is the wire boundary, where the range is a stated
 * invariant rather than a projection detail.
 */
export const latLngToCanvasPixel = ({ lat, lng }: LatLng): CanvasPixel => {
  const latitudeRadians =
    clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE) * RADIANS_PER_DEGREE
  return {
    x: wrapUnitInterval((lng + 180) / 360) * WORLD_PIXELS,
    y:
      ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) *
      WORLD_PIXELS,
  }
}

/** Convert fractional global canvas-pixel coordinates to latitude/longitude. */
export const canvasPixelToLatLng = ({ x, y }: CanvasPixel): LatLng => ({
  lat: Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / WORLD_PIXELS)) * DEGREES_PER_RADIAN,
  lng: (x / WORLD_PIXELS) * 360 - 180,
})
