import { TILE_SIZE } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { markLocalX, markLocalY, packMismatchMark } from '../templates/mismatch-marks.js'
import {
  beginMarkerDensityFrame,
  endMarkerDensityFrame,
  MARKER_VIEWPORT_BUDGET,
  markerDensityMemoryBytes,
  viewportMarkerBatches,
} from './marker-density.js'

afterEach(() => {
  beginMarkerDensityFrame()
  endMarkerDensityFrame()
})

const grid = (width: number, height: number): Uint32Array => {
  const marks = new Uint32Array(width * height)
  let at = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) marks[at++] = packMismatchMark(x, y, 1)
  }
  return marks
}

const batch = (marks: Uint32Array, y = 0) => ({
  tile: { tile: { x: 0, y: 0 }, x: 0, y, width: TILE_SIZE, height: TILE_SIZE / 2 },
  marks,
  padding: 0,
  payload: y,
})

describe('viewport marker density', () => {
  it('draws every marker when the visible total fits the viewport budget', () => {
    const marks = grid(128, 128)

    const [visible] = viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
    )

    expect(marks).toHaveLength(MARKER_VIEWPORT_BUDGET)
    expect(visible?.marks).toBe(marks)
  })

  it('clips a dense backing tile before applying the marker budget', () => {
    const marks = grid(TILE_SIZE, TILE_SIZE)

    const [visible] = viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: {
            tile: { x: 0, y: 0 },
            x: 0,
            y: 0,
            width: TILE_SIZE * 100,
            height: TILE_SIZE * 100,
          },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
    )

    expect(visible?.marks).toHaveLength(100)
  })

  it('spreads an overflowing budget across separated visible regions', () => {
    const top = grid(200, 100)
    const bottom = grid(200, 100)

    const visible = viewportMarkerBatches([batch(top, 0), batch(bottom, TILE_SIZE / 2)], {
      width: TILE_SIZE,
      height: TILE_SIZE,
    })

    expect(visible.reduce((total, item) => total + item.marks.length, 0)).toBe(
      MARKER_VIEWPORT_BUDGET,
    )
    expect(visible[0]?.marks.length).toBeGreaterThan(0)
    expect(visible[1]?.marks.length).toBeGreaterThan(0)
    expect(markLocalY(visible[0]?.marks[0] as number)).toBe(0)
    expect(markLocalY(visible[1]?.marks.at(-1) as number)).toBe(99)
  })

  it('protects an isolated marker while sampling a dense cluster', () => {
    const dense = grid(200, 100)
    const marks = new Uint32Array(dense.length + 1)
    marks.set(dense)
    marks[dense.length] = packMismatchMark(900, 900, 1)

    const [visible] = viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
      100,
    )

    expect(visible?.marks).toHaveLength(100)
    expect(
      visible?.marks.some((mark) => markLocalX(mark) === 900 && markLocalY(mark) === 900),
    ).toBe(true)
  })

  it('keeps sparse markers even when they exceed the soft target', () => {
    const marks = new Uint32Array([
      packMismatchMark(10, 10, 1),
      packMismatchMark(500, 500, 1),
      packMismatchMark(900, 900, 1),
    ])

    const [visible] = viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
      1,
    )

    expect(visible?.marks).toEqual(marks)
  })

  it('treats coincident markers from overlapping batches as dense', () => {
    const coincident = new Uint32Array([packMismatchMark(500, 500, 1)])
    const visible = viewportMarkerBatches(
      Array.from({ length: 8 }, () => ({
        ...batch(coincident),
        tile: { tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
      })),
      { width: TILE_SIZE, height: TILE_SIZE },
      1,
    )

    expect(visible.reduce((total, item) => total + item.marks.length, 0)).toBe(1)
  })

  it('keeps distinct sparse splits for batches that share one source array', () => {
    const source = new Uint32Array([
      ...Array.from({ length: 10 }, (_, x) => packMismatchMark(x, 0, 1)),
      packMismatchMark(400, 0, 1),
      packMismatchMark(800, 0, 1),
    ])
    const one = new Uint32Array([packMismatchMark(0, 0, 1)])
    const placed = (marks: Uint32Array, x: number) => ({
      ...batch(marks),
      tile: { tile: { x: 0, y: 0 }, x, y: 0, width: TILE_SIZE, height: TILE_SIZE },
    })
    const visible = viewportMarkerBatches(
      [
        placed(source, 0),
        placed(source, 1_500),
        ...Array.from({ length: 5 }, () => placed(one, 400)),
        ...Array.from({ length: 5 }, () => placed(one, 2_300)),
      ],
      { width: 4_000, height: TILE_SIZE },
      14,
    )

    const first = [...(visible[0]?.marks ?? [])].map(markLocalX)
    const second = [...(visible[1]?.marks ?? [])].map(markLocalX)
    expect(first).toContain(800)
    expect(first).not.toContain(400)
    expect(second).toContain(400)
    expect(second).not.toContain(800)
  })

  it('reuses stable samples so WebGL buffers are not uploaded again every frame', () => {
    const marks = grid(200, 100)
    const work = [batch(marks)]
    const viewport = { width: TILE_SIZE, height: TILE_SIZE }

    beginMarkerDensityFrame()
    const [first] = viewportMarkerBatches(work, viewport, 1_000)
    endMarkerDensityFrame()
    beginMarkerDensityFrame()
    const [second] = viewportMarkerBatches(work, viewport, 1_000)
    endMarkerDensityFrame()

    expect(second?.marks).toBe(first?.marks)
  })

  it('releases clipping buffers when the whole source becomes visible', () => {
    const marks = grid(TILE_SIZE, TILE_SIZE)
    beginMarkerDensityFrame()
    viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: {
            tile: { x: 0, y: 0 },
            x: 0,
            y: 0,
            width: TILE_SIZE * 100,
            height: TILE_SIZE * 100,
          },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
    )
    endMarkerDensityFrame()
    expect(markerDensityMemoryBytes()).toBeGreaterThan(0)

    beginMarkerDensityFrame()
    viewportMarkerBatches(
      [
        {
          ...batch(marks),
          tile: {
            tile: { x: 0, y: 0 },
            x: 0,
            y: 0,
            width: TILE_SIZE,
            height: TILE_SIZE,
          },
        },
      ],
      { width: TILE_SIZE, height: TILE_SIZE },
      marks.length,
    )
    endMarkerDensityFrame()

    expect(markerDensityMemoryBytes()).toBe(0)
  })
})
