import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  drawableIndices,
  isColourHidden,
  legacyAppearanceGroups,
  normaliseAppearance,
  stampContains,
} from './appearance.js'

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

  it('translates legacy square, circle and anchor settings into the deformable stamp', () => {
    expect(
      normaliseAppearance({
        shape: 'circle',
        size: 0.4,
        anchor: 'br',
        opacity: 0.6,
        hiddenColours: [2],
      }),
    ).toMatchObject({
      size: 0.4,
      radius: 1,
      translateX: 0.3,
      translateY: 0.3,
      rotation: 0,
      opacity: 0.6,
      hiddenColours: [2],
    })
    expect(legacyAppearanceGroups({ shape: 'circle', size: 0.4, anchor: 'br' })).toEqual(['pixels'])

    const triangle = normaliseAppearance({ shape: 'triangle', size: 0.4, anchor: 'tl' })
    expect(triangle).not.toBeNull()
    expect(triangle === null ? false : stampContains(triangle, 0.05, 0.05)).toBe(true)
    expect(triangle === null ? false : stampContains(triangle, 0.3, 0.3)).toBe(false)
  })

  it('keeps the untouched legacy default attached to global appearance settings', () => {
    expect(
      legacyAppearanceGroups({
        shape: 'full',
        size: 1 / 3,
        anchor: 'c',
        opacity: 1,
        hiddenColours: [],
      }),
    ).toEqual([])
  })
})
