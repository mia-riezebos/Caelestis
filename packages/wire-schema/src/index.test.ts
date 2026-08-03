import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PaintPixels } from './index.js'

describe('PaintPixels', () => {
  it('accepts equal-length coordinate and colour arrays', () => {
    expect(Schema.decodeUnknownSync(PaintPixels)({ x: [1, 2], y: [3, 4], colors: [5, 6] })).toEqual(
      { x: [1, 2], y: [3, 4], colors: [5, 6] },
    )
  })

  it('rejects unequal-length coordinate and colour arrays', () => {
    expect(() =>
      Schema.decodeUnknownSync(PaintPixels)({ x: [1, 2], y: [3], colors: [5, 6] }),
    ).toThrow()
  })
})
