import { WPLACE_PALETTE } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { buildExactRgbIndex, exactRgbIndex } from './rgb-index.js'

describe('exact RGB palette index', () => {
  it('finds every exact palette colour without a 24-bit table', () => {
    const table = buildExactRgbIndex(WPLACE_PALETTE)

    for (const colour of WPLACE_PALETTE) {
      expect(exactRgbIndex(table, ...colour.rgb, 255)).toBe(colour.index)
    }
    expect(table.byteLength).toBe(256 * 1024)
  })

  it('rejects a different green value with the same red and blue', () => {
    const table = buildExactRgbIndex([{ rgb: [10, 20, 30], index: 7 }])

    expect(exactRgbIndex(table, 10, 21, 30, 255)).toBe(255)
  })

  it('guards the compact table against red-green collisions', () => {
    expect(() =>
      buildExactRgbIndex([
        { rgb: [10, 20, 30], index: 1 },
        { rgb: [10, 21, 30], index: 2 },
      ]),
    ).toThrow('red-blue collision')
  })
})
