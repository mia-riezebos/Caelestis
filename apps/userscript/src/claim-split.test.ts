import { type RegionItem, regionDocumentPixels, regionShapeContainsPixel } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { splitItem, strokeArea } from './claim-split.js'

let seq = 0
const nextId = (): string => `p${seq++}`

describe('splitting shapes with the eraser', () => {
  it('cuts a rectangle in two with a stroke across it', () => {
    const item: RegionItem = {
      id: 'a',
      op: 'add',
      shape: { kind: 'rectangle', x: 0, y: 0, w: 40, h: 20 },
    }
    const eraser = strokeArea(
      [
        { x: 20, y: -5 },
        { x: 20, y: 25 },
      ],
      4,
    )
    const pieces = splitItem(item, eraser, nextId)
    expect(pieces).toHaveLength(2)
    expect(pieces.every((piece) => piece.shape.kind === 'path' && piece.op === 'add')).toBe(true)
    const pixels = regionDocumentPixels({ items: pieces })
    expect(pixels).not.toBeNull()
    // The eraser took a 4 px wide band out of the 800; the two halves keep the rest.
    expect(pixels?.count).toBe(40 * 20 - 4 * 20)
    expect(regionShapeContainsPixel(pieces[0]?.shape as RegionItem['shape'], 5, 5)).toBe(true)
    expect(regionShapeContainsPixel(pieces[0]?.shape as RegionItem['shape'], 20, 5)).toBe(false)
  })

  it('leaves a hole as a subtract path and removes a shape the eraser covers', () => {
    const item: RegionItem = {
      id: 'a',
      op: 'add',
      shape: { kind: 'rectangle', x: 0, y: 0, w: 30, h: 30 },
    }
    const hole = strokeArea([{ x: 15, y: 15 }], 10)
    const pieces = splitItem(item, hole, nextId)
    expect(pieces.map((piece) => piece.op)).toEqual(['add', 'subtract'])
    const pixels = regionDocumentPixels({ items: pieces })
    expect(regionShapeContainsPixel(pieces[0]?.shape as RegionItem['shape'], 15, 15)).toBe(true)
    expect(pixels?.count).toBeLessThan(900)
    expect(pixels?.count).toBeGreaterThan(900 - 100)
    const everything = strokeArea([{ x: 15, y: 15 }], 100)
    expect(splitItem(item, everything, nextId)).toEqual([])
  })

  it('cuts an open brush stroke as its thick outline', () => {
    const item: RegionItem = {
      id: 'a',
      op: 'add',
      shape: {
        kind: 'path',
        closed: false,
        width: 6,
        nodes: [
          { x: 0, y: 10 },
          { x: 60, y: 10 },
        ],
      },
    }
    const eraser = strokeArea(
      [
        { x: 30, y: 0 },
        { x: 30, y: 20 },
      ],
      4,
    )
    const pieces = splitItem(item, eraser, nextId)
    expect(pieces).toHaveLength(2)
  })
})
