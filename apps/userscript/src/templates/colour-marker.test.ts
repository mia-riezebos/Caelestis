import { describe, expect, it } from 'vitest'
import { colourMarksIn } from './colour-marker.js'
import { packMismatchMark } from './mismatch-marks.js'

describe('selected-colour marker coordinates', () => {
  it('marks only the selected template colour from unpainted pixels', () => {
    const first = packMismatchMark(1, 0, 4)
    const second = packMismatchMark(3, 0, 4)
    const selected = [first, second]
    const unpainted = new Uint32Array([first, packMismatchMark(2, 0, 3), second])

    expect([...colourMarksIn(unpainted, 4)]).toEqual(selected)
  })

  it('retains every selected-colour answer without an entry cap', () => {
    const firstSource = new Uint32Array([packMismatchMark(0, 0, 4)])
    const first = colourMarksIn(firstSource, 4)
    const retained: Uint32Array[] = [firstSource]
    for (let tile = 1; tile < 129; tile += 1) {
      const source = new Uint32Array([packMismatchMark(tile, 0, 4)])
      retained.push(source)
      colourMarksIn(source, 4)
    }

    expect(colourMarksIn(firstSource, 4)).toBe(first)
    expect(retained).toHaveLength(129)
  })
})
