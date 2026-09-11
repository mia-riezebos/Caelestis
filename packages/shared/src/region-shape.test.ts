import { describe, expect, it } from 'vitest'
import {
  isRegionShape,
  regionShapeBounds,
  regionShapeCentre,
  regionShapeContains,
  regionShapeOutline,
} from './region-shape.js'

describe('region shapes', () => {
  it('validates each kind', () => {
    expect(isRegionShape({ kind: 'rectangle', x: 0, y: 0, w: 4, h: 3 })).toBe(true)
    expect(isRegionShape({ kind: 'rectangle', x: 0, y: 0, w: 0, h: 3 })).toBe(false)
    expect(isRegionShape({ kind: 'circle', cx: 10, cy: 10, r: 5 })).toBe(true)
    expect(isRegionShape({ kind: 'circle', cx: 10, cy: 10, r: 5_000 })).toBe(false)
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
    expect(isRegionShape({ kind: 'blob' })).toBe(false)
    expect(isRegionShape(null)).toBe(false)
  })

  it('bounds round shapes by their radius and clamps at the origin', () => {
    expect(regionShapeBounds({ kind: 'circle', cx: 3, cy: 50, r: 10 })).toEqual({
      x: 0,
      y: 40,
      w: 13,
      h: 20,
    })
    expect(regionShapeBounds({ kind: 'rectangle', x: 5, y: 6, w: 7, h: 8 })).toEqual({
      x: 5,
      y: 6,
      w: 7,
      h: 8,
    })
  })

  it('outlines polygons and stars with exact vertex counts', () => {
    const hexagon = regionShapeOutline({
      kind: 'polygon',
      cx: 0,
      cy: 0,
      r: 10,
      sides: 6,
      rotation: 0,
    })
    expect(hexagon).toHaveLength(6)
    expect(hexagon[0]).toEqual({ x: 10, y: 0 })
    const star = regionShapeOutline({
      kind: 'star',
      cx: 0,
      cy: 0,
      r: 10,
      inner: 4,
      points: 5,
      rotation: 0,
    })
    expect(star).toHaveLength(10)
    expect(Math.hypot(star[1]?.x ?? 0, star[1]?.y ?? 0)).toBeCloseTo(4)
    expect(regionShapeOutline({ kind: 'circle', cx: 0, cy: 0, r: 1000 })).toHaveLength(96)
    expect(regionShapeOutline({ kind: 'circle', cx: 0, cy: 0, r: 8 })).toHaveLength(24)
  })

  it('hit tests every kind', () => {
    expect(regionShapeContains({ kind: 'rectangle', x: 0, y: 0, w: 4, h: 3 }, 3, 2)).toBe(true)
    expect(regionShapeContains({ kind: 'rectangle', x: 0, y: 0, w: 4, h: 3 }, 4, 2)).toBe(false)
    expect(regionShapeContains({ kind: 'circle', cx: 0, cy: 0, r: 5 }, 3, 4)).toBe(true)
    expect(regionShapeContains({ kind: 'circle', cx: 0, cy: 0, r: 5 }, 4, 4)).toBe(false)
    const star = { kind: 'star', cx: 0, cy: 0, r: 10, inner: 3, points: 5, rotation: 0 } as const
    expect(regionShapeContains(star, 8, 0)).toBe(true)
    expect(regionShapeContains(star, 0, 8)).toBe(false)
    expect(regionShapeCentre({ kind: 'rectangle', x: 0, y: 0, w: 4, h: 2 })).toEqual({ x: 2, y: 1 })
  })
})
