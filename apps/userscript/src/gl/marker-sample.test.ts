import { describe, expect, it } from 'vitest'
import { markerSampleLimit, sampleMarkers } from './marker-sample.js'

describe('marker density sampling', () => {
  it('keeps small lists by identity', () => {
    const marks = new Float32Array([0, 0, 1, 1, 1, 2])
    expect(sampleMarkers(marks, 2)).toBe(marks)
  })

  it('evenly samples dense row-major lists and retains the result', () => {
    const marks = new Float32Array([0, 0, 1, 1, 0, 1, 2, 0, 1, 3, 0, 1, 4, 0, 1, 5, 0, 1])

    const sampled = sampleMarkers(marks, 3)
    expect([...sampled]).toEqual([0, 0, 1, 2, 0, 1, 4, 0, 1])
    expect(sampleMarkers(marks, 3)).toBe(sampled)
  })

  it('retains only the latest zoom-level sample', () => {
    const marks = new Float32Array([0, 0, 1, 1, 0, 1, 2, 0, 1, 3, 0, 1])
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
