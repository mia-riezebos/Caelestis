import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@wts/shared'
import { describe, expect, it } from 'vitest'
import {
  anchorOffset,
  DEFAULT_APPEARANCE,
  drawableIndices,
  isColourHidden,
  scaleFor,
} from './appearance.js'

describe('template appearances', () => {
  it('keeps full pixels native-size and sub-pixel shapes at the recorded 3x scale', () => {
    expect(scaleFor(DEFAULT_APPEARANCE)).toBe(1)
    expect(scaleFor({ ...DEFAULT_APPEARANCE, shape: 'triangle' })).toBe(3)
  })

  it('anchors fractional stamps at corners and centre', () => {
    expect(anchorOffset('tl', 0.25)).toEqual({ x: 0, y: 0 })
    expect(anchorOffset('c', 0.25)).toEqual({ x: 0.375, y: 0.375 })
    expect(anchorOffset('br', 0.25)).toEqual({ x: 0.75, y: 0.75 })
  })

  it('always hides transparency and exposes every drawable palette index once', () => {
    expect(isColourHidden(DEFAULT_APPEARANCE, TRANSPARENT_INDEX)).toBe(true)
    expect(isColourHidden({ ...DEFAULT_APPEARANCE, hiddenColours: [2] }, 2)).toBe(true)
    expect(drawableIndices()).toHaveLength(PALETTE_SIZE - 1)
    expect(drawableIndices()).not.toContain(TRANSPARENT_INDEX)
  })
})
