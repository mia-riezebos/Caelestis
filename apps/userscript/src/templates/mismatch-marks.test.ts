import { describe, expect, it } from 'vitest'
import { markLocalX, markLocalY, markWanted, packMismatchMark } from './mismatch-marks.js'

describe('packed mismatch marks', () => {
  it('stores tile-local coordinates and palette index in one uint32', () => {
    const mark = packMismatchMark(999, 742, 63)

    expect(markLocalX(mark)).toBe(999)
    expect(markLocalY(mark)).toBe(742)
    expect(markWanted(mark)).toBe(63)
  })
})
