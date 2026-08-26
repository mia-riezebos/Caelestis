import { describe, expect, it } from 'vitest'
import { minifyTapGrid, movingMinifyTapGrid, movingOverlayTapCap } from './minify-quality.js'

describe('overlay minification quality', () => {
  it('uses fewer samples for modest footprints and preserves the full grid when far out', () => {
    expect(minifyTapGrid(1)).toBe(1)
    expect(minifyTapGrid(1.5)).toBe(2)
    expect(minifyTapGrid(2.5)).toBe(3)
    expect(minifyTapGrid(4)).toBe(4)
  })

  it('caps only the farthest motion tier and restores full settled quality', () => {
    expect(movingMinifyTapGrid(1)).toBe(1)
    expect(movingMinifyTapGrid(2.5)).toBe(3)
    expect(movingMinifyTapGrid(4)).toBe(3)
    expect(movingOverlayTapCap(23)).toBe(3)
    expect(movingOverlayTapCap(24)).toBe(2)
    expect(movingMinifyTapGrid(4, 24)).toBe(2)
    expect(minifyTapGrid(4)).toBe(4)
  })
})
