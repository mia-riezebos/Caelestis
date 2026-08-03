import { describe, expect, it } from 'vitest'
import {
  canvasPixelToLatLng,
  latLngToCanvasPixel,
  MAX_MERCATOR_LATITUDE,
  parseTileKey,
  TILE_SIZE,
  tileKey,
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

  it('keeps longitude inside the canvas when it exceeds a half turn', () => {
    const { x } = latLngToCanvasPixel({ lat: 0, lng: 361 })
    expect(x).toBe(WORLD_PIXELS)
  })
})
