import { TILE_SIZE } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { markLocalY, packMismatchMark } from '../templates/mismatch-marks.js'
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
