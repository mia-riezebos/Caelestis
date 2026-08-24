import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  PIXEL_STYLE_PRESETS,
  type PixelStylePresetId,
} from '../templates/appearance.js'
import { appearanceTransitionSet } from './appearance-transition.js'
import { FADE_MS } from './fade.js'

const preset = (id: PixelStylePresetId) => {
  const found = PIXEL_STYLE_PRESETS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`missing ${id} preset`)
  return { ...DEFAULT_APPEARANCE, ...found.values }
}

describe('appearance preset transitions', () => {
  it('uses the shared fade duration and easing to tween all pixel controls', () => {
    const transitions = appearanceTransitionSet()
    expect(transitions.advance('a', DEFAULT_APPEARANCE, 0, false)).toEqual({
      appearance: DEFAULT_APPEARANCE,
      done: true,
    })

    const corner = preset('corner')
    expect(transitions.advance('a', corner, 0, false)).toEqual({
      appearance: DEFAULT_APPEARANCE,
      done: false,
    })
    const halfway = transitions.advance('a', corner, FADE_MS / 2, false)
    expect(halfway.done).toBe(false)
    expect(halfway.appearance.size).toBeCloseTo(1.05)
    expect(halfway.appearance.translateX).toBeCloseTo(-0.375)
    expect(halfway.appearance.translateY).toBe(0)
    expect(halfway.appearance.rotation).toBeCloseTo(22.5)
    expect(halfway.appearance.opacity).toBeCloseTo(0.925)
    expect(transitions.advance('a', corner, FADE_MS, false)).toEqual({
      appearance: corner,
      done: true,
    })
  })

  it('retargets from the value on screen and snaps for sliders or reduced motion', () => {
    const transitions = appearanceTransitionSet()
    transitions.advance('a', DEFAULT_APPEARANCE, 0, false)
    const corner = preset('corner')
    transitions.advance('a', corner, 0, false)
    const halfway = transitions.advance('a', corner, FADE_MS / 2, false).appearance

    const towardsFull = transitions.advance('a', preset('full'), FADE_MS / 2, false)
    expect(towardsFull.appearance).toEqual(halfway)
    expect(towardsFull.done).toBe(false)

    const manual = { ...DEFAULT_APPEARANCE, size: 0.7 }
    expect(transitions.advance('a', manual, FADE_MS / 2, false)).toEqual({
      appearance: manual,
      done: true,
    })
    expect(transitions.advance('a', corner, FADE_MS, true)).toEqual({
      appearance: corner,
      done: true,
    })
  })
})
