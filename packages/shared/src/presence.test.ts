import { describe, expect, it } from 'vitest'
import {
  decodePresenceDraftMask,
  encodePresenceDraft,
  isPresenceDraft,
  isPresenceRect,
  MAX_PRESENCE_MASK_BITS,
  padRect,
  presenceHue,
  quantiseRect,
  rectIntersection,
  rectsIntersect,
} from './presence.js'

describe('presence rects', () => {
  it('validates canvas rects', () => {
    expect(isPresenceRect({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(isPresenceRect({ x: -1, y: 0, w: 1, h: 1 })).toBe(false)
    expect(isPresenceRect({ x: 0, y: 0, w: 0, h: 1 })).toBe(false)
    expect(isPresenceRect({ x: 0.5, y: 0, w: 1, h: 1 })).toBe(false)
    expect(isPresenceRect(null)).toBe(false)
  })

  it('intersects and pads', () => {
    const a = { x: 10, y: 10, w: 20, h: 20 }
    expect(rectsIntersect(a, { x: 29, y: 29, w: 5, h: 5 })).toBe(true)
    expect(rectsIntersect(a, { x: 30, y: 10, w: 5, h: 5 })).toBe(false)
    expect(rectIntersection(a, { x: 20, y: 0, w: 20, h: 15 })).toEqual({
      x: 20,
      y: 10,
      w: 10,
      h: 5,
    })
    expect(rectIntersection(a, { x: 40, y: 40, w: 1, h: 1 })).toBeNull()
    expect(padRect({ x: 5, y: 500, w: 10, h: 10 }, 100)).toEqual({ x: 0, y: 400, w: 210, h: 210 })
  })

  it('quantises outward to the grid', () => {
    expect(quantiseRect({ x: 13, y: 9, w: 3, h: 1 })).toEqual({ x: 8, y: 8, w: 8, h: 8 })
    expect(quantiseRect({ x: 13, y: 9, w: 4, h: 1 })).toEqual({ x: 8, y: 8, w: 16, h: 8 })
    expect(quantiseRect({ x: 16, y: 16, w: 16, h: 16 })).toEqual({ x: 16, y: 16, w: 16, h: 16 })
  })
})

describe('presence drafts', () => {
  it('round-trips a sparse mask', () => {
    const pixels = [
      { x: 100, y: 200 },
      { x: 103, y: 200 },
      { x: 100, y: 202 },
    ]
    const draft = encodePresenceDraft(pixels)
    expect(draft).not.toBeNull()
    expect(draft?.rect).toEqual({ x: 100, y: 200, w: 4, h: 3 })
    expect(draft?.pixels).toBe(3)
    expect(isPresenceDraft(draft)).toBe(true)
    const mask = decodePresenceDraftMask(draft as NonNullable<typeof draft>)
    expect(mask).not.toBeNull()
    expect(Array.from(mask ?? [])).toEqual([1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0])
  })

  it('drops the mask past the bit budget but keeps the rect and count', () => {
    const side = Math.ceil(Math.sqrt(MAX_PRESENCE_MASK_BITS)) + 1
    const draft = encodePresenceDraft([
      { x: 0, y: 0 },
      { x: side - 1, y: side - 1 },
    ])
    expect(draft?.mask).toBeUndefined()
    expect(draft?.pixels).toBe(2)
    expect(isPresenceDraft(draft)).toBe(true)
    expect(decodePresenceDraftMask(draft as NonNullable<typeof draft>)).toBeNull()
  })

  it('rejects malformed masks', () => {
    expect(isPresenceDraft({ rect: { x: 0, y: 0, w: 8, h: 1 }, pixels: 1, mask: 'AA' })).toBe(false)
    expect(isPresenceDraft({ rect: { x: 0, y: 0, w: 8, h: 1 }, pixels: 1, mask: 'AA==' })).toBe(
      true,
    )
    expect(isPresenceDraft({ rect: { x: 0, y: 0, w: 8, h: 1 }, pixels: -1 })).toBe(false)
    expect(encodePresenceDraft([])).toBeNull()
  })

  it('gives a painter a stable hue', () => {
    expect(presenceHue(42)).toBe(presenceHue(42))
    expect(presenceHue(42)).toBeGreaterThanOrEqual(0)
    expect(presenceHue(42)).toBeLessThan(360)
  })
})
