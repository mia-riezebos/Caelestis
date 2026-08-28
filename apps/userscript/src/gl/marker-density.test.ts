import { describe, expect, it } from 'vitest'
import {
  MARKER_VIEWPORT_BUDGET,
  markerDensityMemoryBytes,
  markerSampleRate,
} from './marker-density.js'

describe('GPU marker sampling', () => {
  it('keeps every vertex when the source fits the budget', () => {
    expect(markerSampleRate(MARKER_VIEWPORT_BUDGET)).toBe(1)
    expect(markerSampleRate(100, 4_096)).toBe(1)
  })

  it('turns an overflowing budget into an approximate keep rate', () => {
    expect(markerSampleRate(32_768, 4_096)).toBe(0.125)
  })

  it('handles empty and disabled targets without retained CPU buffers', () => {
    expect(markerSampleRate(0, 4_096)).toBe(0)
    expect(markerSampleRate(100, 0)).toBe(0)
    expect(markerDensityMemoryBytes()).toBe(0)
  })
})
