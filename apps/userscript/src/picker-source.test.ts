import { TILE_SIZE } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { pickerIndex, pixelArtIndexAt } from './picker-source.js'

describe('colour picker sources', () => {
  it('prefers the template overlay, then falls back to the pixel-art layer', () => {
    expect(pickerIndex({ template: 12, pixelArt: 7 })).toBe(12)
    expect(pickerIndex({ template: null, pixelArt: 7 })).toBe(7)
    expect(pickerIndex({ template: null, pixelArt: null })).toBeNull()
  })

  it('reads the exact pixel-art tile index without a composited canvas', () => {
    const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(255)
    pixels[5 * TILE_SIZE + 4] = 23
    const lookedUp: Array<{ x: number; y: number }> = []

    expect(
      pixelArtIndexAt(TILE_SIZE + 4.9, 2 * TILE_SIZE + 5.1, (tile) => {
        lookedUp.push(tile)
        return pixels
      }),
    ).toBe(23)
    expect(lookedUp).toEqual([{ x: 1, y: 2 }])
  })

  it('does not offer uncached or unpainted base pixels', () => {
    const unpainted = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(255)
    expect(pixelArtIndexAt(0, 0, () => null)).toBeNull()
    expect(pixelArtIndexAt(0, 0, () => unpainted)).toBeNull()
  })

  it('never admits draft or marker colours as fallbacks', () => {
    const compositedLayers = { template: null, pixelArt: 7, draft: 31, marker: 57 }
    expect(pickerIndex(compositedLayers)).toBe(7)
    expect(pickerIndex({ ...compositedLayers, pixelArt: null })).toBeNull()
  })
})
