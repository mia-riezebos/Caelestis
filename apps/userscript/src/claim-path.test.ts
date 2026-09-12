import { flattenPath, type PathNode } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  anchorNear,
  cornerAnchor,
  insertAnchor,
  nearestOnPath,
  orientToContinue,
  removeAnchor,
  rubberBand,
  smoothAnchor,
} from './claim-path.js'

const curve: PathNode[] = [
  { x: 0, y: 0, out: { x: 30, y: -40 } },
  { x: 100, y: 0, in: { x: 70, y: -40 } },
]

describe('path editing', () => {
  it('finds the closest point on a straight and on a curved segment', () => {
    const straight = nearestOnPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      false,
      { x: 40, y: 5 },
    )
    expect(straight).toMatchObject({ index: 0, distance: 5 })
    expect(straight?.at).toEqual({ x: 40, y: 0 })
    expect(straight?.t).toBeCloseTo(0.4)
    const curved = nearestOnPath(curve, false, { x: 50, y: -30 })
    expect(curved?.index).toBe(0)
    expect(curved?.t).toBeCloseTo(0.5, 1)
    expect(curved?.distance).toBeLessThan(2)
  })

  it('inserts an anchor on a curve without changing the curve', () => {
    const before = flattenPath(curve, false)
    const split = insertAnchor(curve, 0, 0.5)
    expect(split).toHaveLength(3)
    expect(split[1]?.in).toBeDefined()
    expect(split[1]?.out).toBeDefined()
    const after = flattenPath(split, false)
    // Every point of the original curve lies on the split one.
    for (const point of before) {
      const nearest = nearestOnPath(split, false, point)
      expect(nearest?.distance ?? 99).toBeLessThan(0.05)
    }
    for (const point of after) {
      const nearest = nearestOnPath(curve, false, point)
      expect(nearest?.distance ?? 99).toBeLessThan(0.05)
    }
    const straight = insertAnchor(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0,
      0.25,
    )
    expect(straight).toEqual([
      { x: 0, y: 0 },
      { x: 2.5, y: 0 },
      { x: 10, y: 0 },
    ])
  })

  it('removes anchors, converts corners and smooth anchors, and reorients to continue', () => {
    expect(removeAnchor(curve, 0)).toEqual([curve[1]])
    const smooth = smoothAnchor({ x: 10, y: 10 }, { x: 15, y: 12 })
    expect(smooth).toEqual({ x: 10, y: 10, out: { x: 15, y: 12 }, in: { x: 5, y: 8 } })
    expect(cornerAnchor(smooth)).toEqual({ x: 10, y: 10 })
    expect(orientToContinue(curve, 1)).toEqual(curve)
    expect(orientToContinue(curve, 0)).toEqual([
      { x: 100, y: 0, out: { x: 70, y: -40 } },
      { x: 0, y: 0, in: { x: 30, y: -40 } },
    ])
  })

  it('finds anchors within reach and draws a rubber band from the last one', () => {
    expect(anchorNear(curve, { x: 98, y: 3 }, 5)).toBe(1)
    expect(anchorNear(curve, { x: 50, y: 0 }, 5)).toBeNull()
    const band = rubberBand(curve[0] as PathNode, { x: 50, y: 50 }, 4)
    expect(band[0]).toEqual({ x: 0, y: 0 })
    expect(band[4]).toEqual({ x: 50, y: 50 })
    expect(band[1]?.y).toBeLessThan(0)
  })
})
