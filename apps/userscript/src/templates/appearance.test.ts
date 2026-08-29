import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  drawableIndices,
  isColourHidden,
  legacyAppearanceGroups,
  normaliseAppearance,
  PIXEL_STYLE_PRESETS,
  pixelStylePresetOf,
  stampContains,
} from './appearance.js'

describe('template appearances', () => {
  it('starts with the product appearance defaults', () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      size: 0.6,
      radius: 0,
      translateX: 0,
      translateY: 0,
      rotation: 0,
      opacity: 0.85,
      contrastOutline: true,
      contrastOutlineSize: 0.4,
      hiddenColours: [],
      markMismatch: false,
      markUnpainted: false,
      unpaintedLimit: 0.05,
      markerColour: '#ff00ff',
      markerSize: 9,
      markSelectedColour: false,
      selectedMarkerColour: '#00e5ff',
      selectedMarkerSize: 9,
      dimOthers: true,
      otherOpacity: 0.15,
      otherColour: null,
    })
  })

  it('preserves the original outline on upgrade and bounds configurable thickness', () => {
    expect(normaliseAppearance({})).toMatchObject({
      contrastOutline: true,
      contrastOutlineSize: 0.4,
    })
    expect(normaliseAppearance({ contrastOutline: false, contrastOutlineSize: 4 })).toMatchObject({
      contrastOutline: false,
      contrastOutlineSize: 2,
    })
    expect(normaliseAppearance({ contrastOutline: 'no', contrastOutlineSize: 0 })).toMatchObject({
      contrastOutline: true,
      contrastOutlineSize: 0.25,
    })
  })

  it('defines the three editable Wplace pixel-style shortcuts', () => {
    expect(PIXEL_STYLE_PRESETS).toEqual([
      {
        id: 'small',
        label: 'Small pixel',
        values: {
          size: 0.6,
          radius: 0,
          translateX: 0,
          translateY: 0,
          rotation: 0,
          opacity: 1,
        },
      },
      {
        id: 'full',
        label: 'Full pixel',
        values: {
          size: 1,
          radius: 0,
          translateX: 0,
          translateY: 0,
          rotation: 0,
          opacity: 0.6,
        },
      },
      {
        id: 'corner',
        label: 'Corner',
        values: {
          size: 1.5,
          radius: 0,
          translateX: -0.75,
          translateY: 0,
          rotation: 45,
          opacity: 1,
        },
      },
    ])
    expect(pixelStylePresetOf({ ...DEFAULT_APPEARANCE, ...PIXEL_STYLE_PRESETS[0]?.values })).toBe(
      'small',
    )
    expect(pixelStylePresetOf(DEFAULT_APPEARANCE)).toBeNull()
  })

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
