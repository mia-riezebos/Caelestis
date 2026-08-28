import { describe, expect, it } from 'vitest'
import { packMismatchMark } from '../templates/mismatch-marks.js'
import {
  MARKER_VIEWPORT_BUDGET,
  markerDensityMemoryBytes,
  markerHash,
  markerSampleRate,
  sampledMarkerPopulation,
  visibleMarkerPoints,
} from './marker-density.js'

describe('GPU marker sampling', () => {
  it('keeps every vertex when the source fits the budget', () => {
    expect(markerSampleRate(MARKER_VIEWPORT_BUDGET)).toBe(1)
    expect(markerSampleRate(100, 4_096)).toBe(1)
  })

  it('turns an overflowing budget into an approximate keep rate', () => {
    expect(markerSampleRate(32_768, 4_096)).toBe(0.125)
  })

  it('keeps dense shader populations close to low targets', () => {
    const source = 1_048_576
    const target = 4_096
    const retained = sampledMarkerPopulation(source, markerSampleRate(source, target), 0x52ab_91d3)

    expect(retained).toBeGreaterThan(target * 0.9)
    expect(retained).toBeLessThan(target * 1.1)
    expect(markerHash(source - 1, 0x52ab_91d3)).not.toBe(markerHash(source - 2, 0x52ab_91d3))
  })

  it('handles empty and disabled targets without retained CPU buffers', () => {
    expect(markerSampleRate(0, 4_096)).toBe(0)
    expect(markerSampleRate(100, 0)).toBe(0)
    expect(markerDensityMemoryBytes()).toBe(0)
  })

  it('counts a legal coordinate cluster inside a clipped tile sliver', () => {
    const marks = new Uint32Array(20_000)
    let at = 0
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) marks[at++] = packMismatchMark(x, y, 1)
    }
    for (let y = 900; y < 1_000; y++) {
      for (let x = 900; x < 1_000; x++) marks[at++] = packMismatchMark(x, y, 1)
    }

    expect(
      visibleMarkerPoints(marks, { x: -900, y: -900, width: 1_000, height: 1_000 }, 100, 100),
    ).toBe(10_000)
  })
})
