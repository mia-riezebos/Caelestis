import { describe, expect, it } from 'vitest'
import { sampleMarkers } from './marker-sample.js'

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
})
