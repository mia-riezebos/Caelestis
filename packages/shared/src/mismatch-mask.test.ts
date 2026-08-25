import { describe, expect, it } from 'vitest'
import {
  BLANK,
  decodeMismatchMask,
  encodeMismatchMask,
  MATCH,
  mismatchClassAt,
  WRONG,
} from './mismatch-mask.js'

describe('mismatch mask', () => {
  it('round-trips four classifications per byte within its tile rectangle', () => {
    const encoded = encodeMismatchMask(
      { left: 12, top: 34, width: 3, height: 2 },
      new Uint8Array([MATCH, WRONG, BLANK, WRONG, MATCH, BLANK]),
    )
    const mask = decodeMismatchMask(encoded)

    expect(mask).not.toBeNull()
    expect(mask && mismatchClassAt(mask, 12, 34)).toBe(MATCH)
    expect(mask && mismatchClassAt(mask, 13, 34)).toBe(WRONG)
    expect(mask && mismatchClassAt(mask, 14, 34)).toBe(BLANK)
    expect(mask && mismatchClassAt(mask, 14, 35)).toBe(BLANK)
    expect(mask && mismatchClassAt(mask, 11, 34)).toBeNull()
  })

  it('rejects truncated and unknown mask formats', () => {
    const encoded = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    expect(decodeMismatchMask(encoded.subarray(0, encoded.length - 1))).toBeNull()
    encoded[0] = 0
    expect(decodeMismatchMask(encoded)).toBeNull()
    const unknown = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    unknown[12] = 3
    expect(decodeMismatchMask(unknown)).toBeNull()
  })
})
