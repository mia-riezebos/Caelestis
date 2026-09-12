import { describe, expect, it } from 'vitest'
import {
  flattenPath,
  isRegionDocument,
  isRegionShape,
  type RegionDocument,
  type RegionShape,
  regionDocumentBounds,
  regionDocumentContainsPixel,
  regionDocumentPixels,
  regionPixelComponents,
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
    expect(isRegionShape({ kind: 'polygon', cx: 1, cy: 1, r: 5, sides: 6, rotation: 0 })).toBe(true)
    expect(isRegionShape({ kind: 'polygon', cx: 1, cy: 1, r: 5, sides: 2, rotation: 0 })).toBe(
      false,
    )
    expect(
      isRegionShape({ kind: 'star', cx: 1, cy: 1, r: 10, inner: 4, points: 5, rotation: 90 }),
    ).toBe(true)
    expect(
      isRegionShape({ kind: 'star', cx: 1, cy: 1, r: 10, inner: 10, points: 5, rotation: 90 }),
    ).toBe(false)
    const path = {
      kind: 'path',
      closed: true,
      width: 0,
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0, out: { x: 12, y: 4 } },
        { x: 10, y: 10 },
      ],
    }
    expect(isRegionShape(path)).toBe(true)
    expect(isRegionShape({ ...path, closed: false, width: 0 })).toBe(false)
    expect(isRegionShape({ ...path, nodes: path.nodes.slice(0, 2) })).toBe(false)
    expect(isRegionShape({ ...path, width: 500 })).toBe(false)
    expect(isRegionShape(null)).toBe(false)
  })

  it('rasterises a rectangle as every pixel in its box', () => {
    expect(rows({ kind: 'rectangle', x: 3, y: 4, w: 3, h: 2 })).toEqual(['###', '###'])
  })

  it('rasterises an ellipse by pixel centres, symmetric and aliased', () => {
    expect(rows({ kind: 'ellipse', x: 0, y: 0, w: 7, h: 5 })).toEqual([
      '.#####.',
      '#######',
      '#######',
      '#######',
      '.#####.',
    ])
    expect(rows({ kind: 'ellipse', x: 0, y: 0, w: 5, h: 5 })).toEqual([
      '.###.',
      '#####',
      '#####',
      '#####',
      '.###.',
    ])
  })

  it('rasterises a square polygon exactly on the grid', () => {
    const square: RegionShape = { kind: 'polygon', cx: 10, cy: 10, r: 4, sides: 4, rotation: 45 }
    const drawn = rows(square)
    expect(drawn.every((row) => row === drawn[0])).toBe(true)
    expect(drawn[0]).toBe('######')
    expect(regionShapeBounds(square)).toEqual({ x: 7, y: 7, w: 6, h: 6 })
  })

  it('fills a closed straight path and strokes an open one with round ends', () => {
    const triangle: RegionShape = {
      kind: 'path',
      closed: true,
      width: 0,
      nodes: [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 0, y: 6 },
      ],
    }
    expect(rows(triangle)).toEqual([
      '######.',
      '#####..',
      '####...',
      '###....',
      '##.....',
      '#......',
      '.......',
    ])
    const line: RegionShape = {
      kind: 'path',
      closed: false,
      width: 1,
      nodes: [
        { x: 2, y: 2.5 },
        { x: 8, y: 2.5 },
      ],
    }
    // Six pixels under the segment plus one round cap at each end.
    const { rect, count } = regionShapePixels(line)
    expect(count).toBe(8)
    expect(regionShapeContainsPixel(line, 5, 2)).toBe(true)
    expect(regionShapeContainsPixel(line, 5, 4)).toBe(false)
    expect(rect.w).toBeGreaterThanOrEqual(7)
  })

  it('flattens beziers into a polyline that bows towards its handles', () => {
    const curve = flattenPath(
      [
        { x: 0, y: 0, out: { x: 0, y: 10 } },
        { x: 10, y: 0, in: { x: 10, y: 10 } },
      ],
      false,
    )
    expect(curve.length).toBeGreaterThan(4)
    expect(curve[0]).toEqual({ x: 0, y: 0 })
    expect(curve.at(-1)).toEqual({ x: 10, y: 0 })
    const middle = curve[Math.floor(curve.length / 2)]
    expect(middle?.y).toBeGreaterThan(5)
  })

  it('composes a document by adding and subtracting items in order', () => {
    const document: RegionDocument = {
      items: [
        { id: 'a', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 6, h: 4 } },
        { id: 'b', op: 'subtract', shape: { kind: 'rectangle', x: 2, y: 1, w: 2, h: 2 } },
        { id: 'c', op: 'add', shape: { kind: 'rectangle', x: 3, y: 1, w: 1, h: 1 } },
      ],
    }
    expect(isRegionDocument(document)).toBe(true)
    expect(regionDocumentBounds(document)).toEqual({ x: 0, y: 0, w: 6, h: 4 })
    const pixels = regionDocumentPixels(document)
    expect(pixels?.count).toBe(21)
    expect(regionDocumentContainsPixel(document, 2, 1)).toBe(false)
    expect(regionDocumentContainsPixel(document, 3, 1)).toBe(true)
    expect(regionDocumentContainsPixel(document, 5, 3)).toBe(true)
    expect(isRegionDocument({ items: [] })).toBe(false)
    expect(isRegionDocument({ items: [document.items[0], document.items[0]] })).toBe(false)
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

  it('translates by whole pixels, handles included', () => {
    expect(translateRegionShape({ kind: 'rectangle', x: 2, y: 2, w: 1, h: 1 }, -5, 1.4)).toEqual({
      kind: 'rectangle',
      x: 0,
      y: 3,
      w: 1,
      h: 1,
    })
    expect(
      translateRegionShape(
        {
          kind: 'path',
          closed: false,
          width: 2,
          nodes: [
            { x: 1, y: 1, out: { x: 2, y: 2 } },
            { x: 5, y: 5 },
          ],
        },
        1,
        1,
      ),
    ).toEqual({
      kind: 'path',
      closed: false,
      width: 2,
      nodes: [
        { x: 2, y: 2, out: { x: 3, y: 3 } },
        { x: 6, y: 6 },
      ],
    })
  })
})

describe('regionPixelComponents', () => {
  const doc = (...shapes: RegionShape[]): RegionDocument => ({
    items: shapes.map((shape, index) => ({ id: `s${index}`, op: 'add' as const, shape })),
  })

  it('finds one piece per self-contained group of pixels, largest first', () => {
    const pixels = regionDocumentPixels(
      doc(
        { kind: 'rectangle', x: 0, y: 0, w: 3, h: 3 },
        { kind: 'rectangle', x: 2, y: 2, w: 3, h: 3 },
        { kind: 'rectangle', x: 10, y: 0, w: 2, h: 2 },
      ),
    )
    expect(pixels).not.toBeNull()
    const { boxes, labels } = regionPixelComponents(pixels as NonNullable<typeof pixels>)
    expect(boxes).toEqual([
      { x: 0, y: 0, w: 5, h: 5 },
      { x: 10, y: 0, w: 2, h: 2 },
    ])
    const at = (x: number, y: number): number => labels[y * 12 + x] as number
    expect(at(0, 0)).toBe(1)
    expect(at(4, 4)).toBe(1)
    expect(at(11, 1)).toBe(2)
    expect(at(6, 0)).toBe(0)
  })

  it('joins pixels that only touch at a corner and separates ones with a gap', () => {
    const corner = regionDocumentPixels(
      doc(
        { kind: 'rectangle', x: 0, y: 0, w: 2, h: 2 },
        { kind: 'rectangle', x: 2, y: 2, w: 2, h: 2 },
      ),
    )
    expect(regionPixelComponents(corner as NonNullable<typeof corner>).boxes).toHaveLength(1)
    const gap = regionDocumentPixels(
      doc(
        { kind: 'rectangle', x: 0, y: 0, w: 2, h: 2 },
        { kind: 'rectangle', x: 3, y: 3, w: 2, h: 2 },
      ),
    )
    expect(regionPixelComponents(gap as NonNullable<typeof gap>).boxes).toHaveLength(2)
  })

  it('splits a shape that a subtraction cuts in two', () => {
    const pixels = regionDocumentPixels({
      items: [
        { id: 'a', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 9, h: 3 } },
        { id: 'b', op: 'subtract', shape: { kind: 'rectangle', x: 4, y: 0, w: 1, h: 3 } },
      ],
    })
    const { boxes } = regionPixelComponents(pixels as NonNullable<typeof pixels>)
    expect(boxes).toEqual([
      { x: 0, y: 0, w: 4, h: 3 },
      { x: 5, y: 0, w: 4, h: 3 },
    ])
  })
})
