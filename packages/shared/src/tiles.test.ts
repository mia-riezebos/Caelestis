import { describe, expect, it } from 'vitest'
import {
  canvasPixelToLatLng,
  latLngToCanvasPixel,
  MAX_MERCATOR_LATITUDE,
  MAX_TIMELAPSE_CAPTURE_TILES,
  parseTileKey,
  planTimelapseTiles,
  TILE_SIZE,
  tileKey,
  timelapseCaptureRect,
  timelapseCaptureTileCount,
  WORLD_PIXELS,
} from './tiles.js'

describe('tileKey', () => {
  it('round-trips through parseTileKey', () => {
    expect(parseTileKey(tileKey({ x: 325, y: 1782 }))).toEqual({ x: 325, y: 1782 })
  })
})

describe('parseTileKey', () => {
  it('parses a well-formed key', () => {
    expect(parseTileKey('325/1782')).toEqual({ x: 325, y: 1782 })
  })

  it('rejects non-integer coordinates', () => {
    // Tile coordinates index a grid. A fractional one means whatever produced it was wrong, and
    // silently flooring it would put template chunks on the wrong tile.
    expect(parseTileKey('325.5/1782')).toBeNull()
  })

  it.each(['', '325', '325/', '/1782', '325/1782/0', 'a/b'])('rejects %o', (input) => {
    expect(parseTileKey(input)).toBeNull()
  })

  it.each(['-1/999', '2048/0', '0/2048', '0007/5'])(
    'rejects out-of-range or non-canonical %o',
    (input) => {
      expect(parseTileKey(input)).toBeNull()
    },
  )
})

describe('timelapse capture planning', () => {
  it('centres a portrait template inside a 16:9 capture rectangle', () => {
    expect(
      timelapseCaptureRect({ minX: 325_051, minY: 1_781_650, maxX: 326_663, maxY: 1_784_234 }),
    ).toEqual({
      x: 323_560.1111111111,
      y: 1_781_650,
      width: 4_593.777777777777,
      height: 2_584,
    })
  })

  it('deduplicates the tiles required by overlapping capture rectangles', () => {
    expect(
      planTimelapseTiles([
        { minX: 100_000, minY: 100_000, maxX: 101_000, maxY: 101_000 },
        { minX: 100_000, minY: 100_000, maxX: 101_000, maxY: 101_000 },
        { minX: 101_000, minY: 100_000, maxX: 102_000, maxY: 101_000 },
      ]),
    ).toEqual([
      { x: 99, y: 100 },
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      { x: 102, y: 100 },
    ])
  })

  it('wraps horizontal context and keeps vertical context inside the canvas', () => {
    expect(planTimelapseTiles([{ minX: 0, minY: 0, maxX: 1_000, maxY: 2_000 }])).toEqual([
      { x: 2046, y: 0 },
      { x: 2047, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2046, y: 1 },
      { x: 2047, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ])
  })

  it('rejects capture rectangles that would create an unsafe history request fan-out', () => {
    const bounds = { minX: 0, minY: 0, maxX: 1, maxY: 32_000 }
    expect(timelapseCaptureTileCount(bounds)).toBeGreaterThan(MAX_TIMELAPSE_CAPTURE_TILES)
    expect(() => planTimelapseTiles([bounds])).toThrow(/more than the 1,000 tile limit/)
  })
})

describe('canvas coordinate conversion', () => {
  it('round-trips latitude and longitude', () => {
    const source = { lat: -78.824, lng: -122.862 }
    expect(canvasPixelToLatLng(latLngToCanvasPixel(source))).toEqual({
      lat: expect.closeTo(source.lat, 10),
      lng: expect.closeTo(source.lng, 10),
    })
  })

  it('places the native .wplace fixture in tile (325, 1781)', () => {
    const pixel = latLngToCanvasPixel({ lat: -78.824, lng: -122.862 })
    expect({ x: Math.floor(pixel.x / TILE_SIZE), y: Math.floor(pixel.y / TILE_SIZE) }).toEqual({
      x: 325,
      y: 1781,
    })
    // The tile assertion alone is invariant under TILE_SIZE: WORLD_PIXELS is WORLD_TILES *
    // TILE_SIZE, so the division cancels and the fixture lands in the same tile at any edge length.
    // The absolute pixel does not cancel, so it is what actually pins the constant.
    expect(pixel.x).toBeCloseTo(325_051.733, 3)
    expect(pixel.y).toBeCloseTo(1_781_645.679, 3)
  })

  it('moves x eastward and y southward', () => {
    const origin = latLngToCanvasPixel({ lat: 0, lng: 0 })
    expect(latLngToCanvasPixel({ lat: 0, lng: 1 }).x).toBeGreaterThan(origin.x)
    expect(latLngToCanvasPixel({ lat: -1, lng: 0 }).y).toBeGreaterThan(origin.y)
  })
})

describe('latLngToCanvasPixel at the projection limits', () => {
  // Web Mercator sends the poles to infinity, so an unclamped formula produces Infinity, a large
  // negative, or NaN — each of which would flow into a bounding box and then into tile arithmetic.
  it.each([
    ['south pole', -90],
    ['north pole', 90],
    ['past the south pole', -120],
    ['past the north pole', 120],
  ])('produces a finite in-canvas y at the %s', (_label, lat) => {
    const { y } = latLngToCanvasPixel({ lat, lng: 0 })
    expect(Number.isFinite(y)).toBe(true)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(WORLD_PIXELS)
  })

  it('clamps to the same pixel as the Mercator limit itself', () => {
    expect(latLngToCanvasPixel({ lat: -90, lng: 0 })).toEqual(
      latLngToCanvasPixel({ lat: -MAX_MERCATOR_LATITUDE, lng: 0 }),
    )
  })

  it('puts the Mercator limit exactly on the canvas edges', () => {
    // The test above routes both operands through the same clamp with the same constant, so it
    // holds for any value of MAX_MERCATOR_LATITUDE and pins nothing. What defines the constant is
    // that it is the parallel where the projection becomes square: it maps to the canvas edge.
    // Asserting that makes the value itself falsifiable.
    expect(latLngToCanvasPixel({ lat: MAX_MERCATOR_LATITUDE, lng: 0 }).y).toBeCloseTo(0, 6)
    expect(latLngToCanvasPixel({ lat: -MAX_MERCATOR_LATITUDE, lng: 0 }).y).toBeCloseTo(
      WORLD_PIXELS,
      6,
    )
  })

  it.each([
    ['a full turn past the prime meridian', 361, 1],
    ['the antimeridian', 180, -180],
    ['a full turn back', -359, 1],
  ])('wraps longitude at %s to the same pixel as its equivalent', (_label, lng, equivalent) => {
    expect(latLngToCanvasPixel({ lat: 0, lng }).x).toBeCloseTo(
      latLngToCanvasPixel({ lat: 0, lng: equivalent }).x,
      6,
    )
  })

  it('never places longitude on the non-existent tile past the last one', () => {
    // Clamping put lng 180 at exactly WORLD_PIXELS, which floors to tile 2048 — one past the end,
    // and rejected by parseTileKey. The canvas wraps in x, so 180 belongs at the same pixel as -180.
    for (const lng of [180, 180.0001, 359.9999, 360, 720]) {
      const { x } = latLngToCanvasPixel({ lat: 0, lng })
      expect(x).toBeLessThan(WORLD_PIXELS)
      expect(parseTileKey(`${Math.floor(x / TILE_SIZE)}/0`)).not.toBeNull()
    }
  })
})
