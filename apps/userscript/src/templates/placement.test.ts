import { WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  horizontalCentre,
  horizontalSpans,
  sourceXAt,
  virtualOriginXAt,
  wrappedDeltaX,
} from './placement.js'

describe('wrapped template placement', () => {
  const wrapped = { originX: WORLD_PIXELS - 2, width: 5, wrapX: true }

  it('maps both world runs back into one contiguous source', () => {
    expect(horizontalSpans(wrapped)).toEqual([
      {
        worldStart: WORLD_PIXELS - 2,
        worldEnd: WORLD_PIXELS,
        sourceStart: 0,
        sourceEnd: 2,
      },
      { worldStart: 0, worldEnd: 3, sourceStart: 2, sourceEnd: 5 },
    ])
    expect(sourceXAt(wrapped, WORLD_PIXELS - 1)).toBe(1)
    expect(sourceXAt(wrapped, 0)).toBe(2)
    expect(virtualOriginXAt(wrapped, 0)).toBe(-2)
    expect(horizontalCentre(wrapped)).toBe(0.5)
  })

  it('measures the short distance across the seam', () => {
    expect(wrappedDeltaX(WORLD_PIXELS - 1, 1)).toBe(2)
    expect(wrappedDeltaX(1, WORLD_PIXELS - 1)).toBe(-2)
  })
})
