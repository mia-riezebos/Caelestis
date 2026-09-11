import { describe, expect, it } from 'vitest'
import {
  isRegionShape,
  type RegionShape,
  regionShapeBounds,
  regionShapeContainsPixel,
  regionShapeOutline,
  regionShapePixels,
  translateRegionShape,
} from './region-shape.js'

const rows = (shape: RegionShape): string[] => {
  const { rect, mask } = regionShapePixels(shape)
  return Array.from({ length: rect.h }, (_, row) =>
    Array.from({ length: rect.w }, (_, x) => (mask[row * rect.w + x] === 1 ? '#' : '.')).join(''),
  )
}

describe('region shapes', () => {
  it('validates each kind', () => {
    expect(isRegionShape({ kind: 'rectangle', x: 0, y: 0, w: 4, h: 3 })).toBe(true)
    expect(isRegionShape({ kind: 'rectangle', x: 0, y: 0, w: 0, h: 3 })).toBe(false)
    expect(isRegionShape({ kind: 'ellipse', x: 10, y: 10, w: 5, h: 9 })).toBe(true)
    expect(isRegionShape({ kind: 'ellipse', x: 10, y: 10, w: 5_000, h: 9 })).toBe(false)
    expect(isRegionShape({ kind: 'circle', cx: 10, cy: 10, r: 5 })).toBe(false)
    expect(isRegionShape({ kind: 'polygon', cx: 1, cy: 1, r: 5, sides: 6, rotation: 0 })).toBe(true)
    expect(isRegionShape({ kind: 'polygon', cx: 1, cy: 1, r: 5, sides: 2, rotation: 0 })).toBe(
      false,
    )
    expect(isRegionShape({ kind: 'polygon', cx: 1, cy: 1, r: 5, sides: 6, rotation: 360 })).toBe(
      false,
    )
    expect(
      isRegionShape({ kind: 'star', cx: 1, cy: 1, r: 10, inner: 4, points: 5, rotation: 90 }),
    ).toBe(true)
    expect(
      isRegionShape({ kind: 'star', cx: 1, cy: 1, r: 10, inner: 10, points: 5, rotation: 90 }),
    ).toBe(false)
    expect(isRegionShape(null)).toBe(false)
  })

  it('rasterises a rectangle as every pixel in its box', () => {
    expect(rows({ kind: 'rectangle', x: 3, y: 4, w: 3, h: 2 })).toEqual(['###', '###'])
    expect(regionShapeBounds({ kind: 'rectangle', x: 3, y: 4, w: 3, h: 2 })).toEqual({
      x: 3,
      y: 4,
      w: 3,
      h: 2,
    })
  })

  it('rasterises an ellipse by pixel centres, symmetric and aliased', () => {
    expect(rows({ kind: 'ellipse', x: 0, y: 0, w: 7, h: 5 })).toEqual([
      '.#####.',
      '#######',
      '#######',
      '#######',
      '.#####.',
    ])
    const { count } = regionShapePixels({ kind: 'ellipse', x: 0, y: 0, w: 7, h: 5 })
    expect(count).toBe(31)
    expect(rows({ kind: 'ellipse', x: 0, y: 0, w: 5, h: 5 })).toEqual([
      '.###.',
      '#####',
      '#####',
      '#####',
      '.###.',
    ])
    expect(regionShapeContainsPixel({ kind: 'ellipse', x: 0, y: 0, w: 7, h: 5 }, 0, 0)).toBe(false)
    expect(regionShapeContainsPixel({ kind: 'ellipse', x: 0, y: 0, w: 7, h: 5 }, 3, 0)).toBe(true)
  })

  it('rasterises a square polygon exactly on the grid', () => {
    // A 4-gon at 45 degrees with r = 4 is an axis-aligned square with corners at ±2.83.
    const square: RegionShape = { kind: 'polygon', cx: 10, cy: 10, r: 4, sides: 4, rotation: 45 }
    const drawn = rows(square)
    expect(drawn.every((row) => row === drawn[0])).toBe(true)
    expect(drawn[0]).toBe('######')
    expect(regionShapeBounds(square)).toEqual({ x: 7, y: 7, w: 6, h: 6 })
  })

  it('agrees between the mask and the pixel hit test for a star', () => {
    const star: RegionShape = {
      kind: 'star',
      cx: 20,
      cy: 20,
      r: 12,
      inner: 5,
      points: 5,
      rotation: 270,
    }
    const { rect, mask } = regionShapePixels(star)
    for (let row = 0; row < rect.h; row++) {
      for (let x = 0; x < rect.w; x++) {
        expect(regionShapeContainsPixel(star, rect.x + x, rect.y + row)).toBe(
          mask[row * rect.w + x] === 1,
        )
      }
    }
    expect(regionShapeOutline(star)).toHaveLength(10)
  })

  it('translates by whole pixels and clamps at the origin', () => {
    expect(translateRegionShape({ kind: 'rectangle', x: 2, y: 2, w: 1, h: 1 }, -5, 1.4)).toEqual({
      kind: 'rectangle',
      x: 0,
      y: 3,
      w: 1,
      h: 1,
    })
    expect(
      translateRegionShape({ kind: 'polygon', cx: 5, cy: 5, r: 2, sides: 3, rotation: 0 }, 2, 2),
    ).toMatchObject({ cx: 7, cy: 7 })
  })
})
