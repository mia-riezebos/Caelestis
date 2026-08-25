import { describe, expect, it } from 'vitest'
import { minifyTapGrid } from './minify-quality.js'

describe('overlay minification quality', () => {
  it('uses fewer samples for modest footprints and preserves the full grid when far out', () => {
    expect(minifyTapGrid(1)).toBe(1)
    expect(minifyTapGrid(1.5)).toBe(2)
    expect(minifyTapGrid(2.5)).toBe(3)
    expect(minifyTapGrid(4)).toBe(4)
  })
})
