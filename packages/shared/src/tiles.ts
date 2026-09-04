import type { BoundingBox } from './manifest.js'

/**
 * wplace serves the world canvas as PNG tiles from
 * `https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png`.
 *
 * Two properties of that endpoint shape everything downstream:
 *
 * - **The season is a runtime value**, not a constant. Hardcoding it means a season rollover
 *   silently stops every template from matching.
 * - **An unpainted in-range tile is a 200, not a 404** — the body is a near-empty PNG. Only
 *   coordinates outside `0..WORLD_TILES - 1` return 404, and `parseTileKey` already rejects those.
 *   Status therefore does not distinguish blank from painted; consumers that need that must read
 *   the body. See `.scratch/v1/issues/06-recon-tile-serving`.
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

/** The world-pixel rectangle captured for each template timelapse. */
export interface TimelapseCaptureRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const TIMELAPSE_ASPECT_RATIO = 16 / 9

/** A single template may ask the viewer for at most this many tile histories. */
export const MAX_TIMELAPSE_CAPTURE_TILES = 1_000

/** Centre the template in the smallest 16:9 rectangle that fully contains its painted bounds. */
export const timelapseCaptureRect = (bounds: BoundingBox): TimelapseCaptureRect => {
  const templateWidth =
    bounds.maxX > bounds.minX ? bounds.maxX - bounds.minX : bounds.maxX + WORLD_PIXELS - bounds.minX
  const templateHeight = bounds.maxY - bounds.minY
  const width = Math.max(templateWidth, templateHeight * TIMELAPSE_ASPECT_RATIO)
  const unclampedHeight = width / TIMELAPSE_ASPECT_RATIO
  const height = Math.min(unclampedHeight, WORLD_PIXELS)
  const x = bounds.minX + templateWidth / 2 - width / 2
  const centredY = bounds.minY + templateHeight / 2 - height / 2
  const y = clamp(centredY, 0, WORLD_PIXELS - height)
  return { x, y, width, height }
}

/** Number of whole canvas tiles touched by one capture rectangle, without enumerating them. */
export const timelapseCaptureTileCount = (bounds: BoundingBox): number => {
  const rect = timelapseCaptureRect(bounds)
  const columns = Math.ceil((rect.x + rect.width) / TILE_SIZE) - Math.floor(rect.x / TILE_SIZE)
  const rows = Math.ceil((rect.y + rect.height) / TILE_SIZE) - Math.floor(rect.y / TILE_SIZE)
  return columns * rows
}

/** Whether a canvas tile intersects the template's 16:9 capture rectangle. */
export const timelapseCaptureIncludesTile = (bounds: BoundingBox, tile: TileCoord): boolean => {
  const rect = timelapseCaptureRect(bounds)
  const firstTileY = Math.floor(rect.y / TILE_SIZE)
  const lastTileY = Math.ceil((rect.y + rect.height) / TILE_SIZE) - 1
  if (tile.y < firstTileY || tile.y > lastTileY) return false

  const firstTileX = Math.floor(rect.x / TILE_SIZE)
  const lastTileX = Math.ceil((rect.x + rect.width) / TILE_SIZE) - 1
  const firstMatchingX = tile.x + Math.ceil((firstTileX - tile.x) / WORLD_TILES) * WORLD_TILES
  return firstMatchingX <= lastTileX
}

/**
 * Plan one fetch per unique tile needed by every template's 16:9 timelapse rectangle.
 * Horizontal context wraps with the canvas. Vertical context shifts inside its fixed edges.
 */
export const planTimelapseTiles = (templates: readonly BoundingBox[]): TileCoord[] => {
  const planned = new Map<TileKey, TileCoord>()
  for (const bounds of templates) {
    const count = timelapseCaptureTileCount(bounds)
    if (count > MAX_TIMELAPSE_CAPTURE_TILES) {
      throw new RangeError(
        `timelapse capture covers ${count.toLocaleString()} tiles, more than the ${MAX_TIMELAPSE_CAPTURE_TILES.toLocaleString()} tile limit`,
      )
    }
    const rect = timelapseCaptureRect(bounds)
    const firstTileX = Math.floor(rect.x / TILE_SIZE)
    const lastTileX = Math.ceil((rect.x + rect.width) / TILE_SIZE) - 1
    const firstTileY = Math.floor(rect.y / TILE_SIZE)
    const lastTileY = Math.ceil((rect.y + rect.height) / TILE_SIZE) - 1
    for (let y = firstTileY; y <= lastTileY; y += 1) {
      for (let x = firstTileX; x <= lastTileX; x += 1) {
        const tile = { x: ((x % WORLD_TILES) + WORLD_TILES) % WORLD_TILES, y }
        const key = tileKey(tile)
        if (!planned.has(key)) planned.set(key, tile)
      }
    }
  }
  return [...planned.values()]
}

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
