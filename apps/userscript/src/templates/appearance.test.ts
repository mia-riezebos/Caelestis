import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, drawableIndices, isColourHidden } from './appearance.js'

describe('template appearances', () => {
  it('always hides transparency and exposes every drawable palette index once', () => {
    expect(isColourHidden(DEFAULT_APPEARANCE, TRANSPARENT_INDEX)).toBe(true)
    expect(isColourHidden({ ...DEFAULT_APPEARANCE, hiddenColours: [2] }, 2)).toBe(true)
    expect(isColourHidden(DEFAULT_APPEARANCE, 2)).toBe(false)
    expect(drawableIndices()).toEqual(
      Array.from({ length: PALETTE_SIZE }, (_, index) => index).filter(
        (index) => index !== TRANSPARENT_INDEX,
      ),
    )
    expect(new Set(drawableIndices()).size).toBe(PALETTE_SIZE - 1)
  })
})
