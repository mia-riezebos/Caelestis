import { WPLACE_PALETTE } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { buildExactRgbIndex, canvasRgbIndex, exactRgbIndex } from './rgb-index.js'

describe('RGB palette index', () => {
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

  it('recovers every palette colour across Helium canvas privacy noise', () => {
    const table = buildExactRgbIndex(WPLACE_PALETTE)

    for (const colour of WPLACE_PALETTE) {
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dg = -2; dg <= 2; dg += 1) {
          for (let db = -2; db <= 2; db += 1) {
            const [r, g, b] = colour.rgb
            expect(
              canvasRgbIndex(
                table,
                Math.max(0, Math.min(255, r + dr)),
                Math.max(0, Math.min(255, g + dg)),
                Math.max(0, Math.min(255, b + db)),
                255,
              ),
            ).toBe(colour.index)
          }
        }
      }
    }
    expect(exactRgbIndex(table, 62, 58, 62, 255)).toBe(255)
  })

  it('does not turn unrelated canvas colours into palette entries', () => {
    const table = buildExactRgbIndex([{ rgb: [60, 60, 60], index: 7 }])

    expect(canvasRgbIndex(table, 63, 60, 60, 255)).toBe(255)
    expect(canvasRgbIndex(table, 10, 20, 30, 255)).toBe(255)
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
