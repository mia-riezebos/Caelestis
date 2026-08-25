import { describe, expect, it } from 'vitest'
import { colourMarksIn } from './colour-marker.js'

describe('selected-colour marker coordinates', () => {
  it('marks only selected pixels that are unpainted or mismatched', () => {
    const disagreements = new Float32Array([1, 0, 4, 2, 0, 3, 3, 0, 4])

    expect([...colourMarksIn(disagreements, 4)]).toEqual([1, 0, 4, 3, 0, 4])
  })

  it('retains every selected-colour answer without an entry cap', () => {
    const firstSource = new Float32Array([0, 0, 4])
    const first = colourMarksIn(firstSource, 4)
    const retained: Float32Array[] = [firstSource]
    for (let tile = 1; tile < 129; tile += 1) {
      const source = new Float32Array([tile, 0, 4])
      retained.push(source)
      colourMarksIn(source, 4)
    }

    expect(colourMarksIn(firstSource, 4)).toBe(first)
    expect(retained).toHaveLength(129)
  })
})
