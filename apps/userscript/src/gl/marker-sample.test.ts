import { describe, expect, it } from 'vitest'
import { packMismatchMark } from '../templates/mismatch-marks.js'
import { markerSampleLimit, sampleMarkers } from './marker-sample.js'

describe('marker density sampling', () => {
  it('keeps small lists by identity', () => {
    const marks = new Uint32Array([packMismatchMark(0, 0, 1), packMismatchMark(1, 1, 2)])
    expect(sampleMarkers(marks, 2)).toBe(marks)
  })

  it('evenly samples dense row-major lists and retains the result', () => {
    const marks = new Uint32Array([0, 1, 2, 3, 4, 5])

    const sampled = sampleMarkers(marks, 3)
    expect([...sampled]).toEqual([0, 2, 4])
    expect(sampleMarkers(marks, 3)).toBe(sampled)
  })

  it('retains only the latest zoom-level sample', () => {
    const marks = new Uint32Array([0, 1, 2, 3])
    const first = sampleMarkers(marks, 2)

    sampleMarkers(marks, 3)

    expect(sampleMarkers(marks, 2)).not.toBe(first)
  })

  it('bounds dense markers by their visible footprint and keeps nearby zooms in one LOD', () => {
    const first = markerSampleLimit(1000, 1000, 18)
    const nearby = markerSampleLimit(1001, 1001, 18)

    expect(first).toBe(16_384)
    expect(nearby).toBe(first)
    expect(first).toBeLessThan(1_000_000)
    expect(markerSampleLimit(1000, 1000, 2)).toBe(1_000_000)
  })
})
