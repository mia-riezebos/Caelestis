import { TILE_SIZE, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  canvasPixelAt,
  draftIn,
  MAX_PUBLISHED_DRAFT_PIXELS,
  rectOnScreen,
  viewportRectIn,
} from './presence-geometry.js'
import type { TileFrame } from './tile-transform.js'

const frame = (
  canvas: { width: number; height: number },
  quads: TileFrame['quads'],
): TileFrame => ({ canvas: canvas as HTMLCanvasElement, quads })

describe('viewportRectIn', () => {
  it('maps the canvas corners back through a drawn tile', () => {
    // Tile 10/20 drawn at (100, 48) at half scale: 1 device pixel = 2 canvas pixels.
    const rect = viewportRectIn(
      frame({ width: 800, height: 600 }, [
        { tile: { x: 10, y: 20 }, x: 100, y: 48, width: TILE_SIZE / 2, height: TILE_SIZE / 2 },
      ]),
    )
    expect(rect).toEqual({
      x: 10 * TILE_SIZE - 200,
      y: 20 * TILE_SIZE - 96,
      w: 1600,
      h: 1200,
    })
  })

  it('clamps to the world and snaps outward to the grid', () => {
    const rect = viewportRectIn(
      frame({ width: 301, height: 203 }, [
        { tile: { x: 0, y: 0 }, x: 5, y: 7, width: TILE_SIZE, height: TILE_SIZE },
      ]),
    )
    expect(rect).toEqual({ x: 0, y: 0, w: 296, h: 200 })
    const far = viewportRectIn(
      frame({ width: 4000, height: 4000 }, [
        { tile: { x: 2047, y: 2047 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
      ]),
    )
    expect(far?.x).toBe(2047 * TILE_SIZE)
    expect((far?.x ?? 0) + (far?.w ?? 0)).toBe(WORLD_PIXELS)
  })

  it('answers null without tiles', () => {
    expect(viewportRectIn(frame({ width: 800, height: 600 }, []))).toBeNull()
  })
})

describe('draftIn', () => {
  it('converts tile-local offsets to canvas pixels across tiles', () => {
    const draft = draftIn(
      [
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ],
      (tile) => (tile.x === 1 ? [999 * TILE_SIZE + 999] : [999 * TILE_SIZE]),
    )
    expect(draft?.rect).toEqual({ x: TILE_SIZE + 999, y: 2 * TILE_SIZE + 999, w: 2, h: 1 })
    expect(draft?.pixels).toBe(2)
    expect(draft?.mask).toBeDefined()
  })

  it('drops the mask past the cap but keeps the exact bounds and count of the whole draft', () => {
    const offsets = Array.from({ length: MAX_PUBLISHED_DRAFT_PIXELS + 5 }, (_, i) => i)
    // A second tile far away holds one more pixel: the rect and count still cover it.
    const draft = draftIn(
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
      (tile) => (tile.x === 0 ? offsets : [7 * TILE_SIZE + 9]),
    )
    expect(draft?.pixels).toBe(MAX_PUBLISHED_DRAFT_PIXELS + 6)
    expect(draft?.mask).toBeUndefined()
    expect(draft?.rect).toEqual({
      x: 0,
      y: 0,
      w: 3 * TILE_SIZE + 10,
      h: 4 * TILE_SIZE + 8,
    })
  })

  it('is null with nothing drafted', () => {
    expect(draftIn([], () => [])).toBeNull()
  })
})

describe('rectOnScreen', () => {
  const held = frame({ width: 800, height: 600 }, [
    { tile: { x: 10, y: 20 }, x: 100, y: 50, width: TILE_SIZE / 2, height: TILE_SIZE / 2 },
  ])

  it('projects a canvas rect onto device pixels', () => {
    expect(rectOnScreen(held, { x: 10 * TILE_SIZE + 10, y: 20 * TILE_SIZE, w: 20, h: 40 })).toEqual(
      { x: 105, y: 50, width: 10, height: 20 },
    )
  })

  it('answers null when the rect is entirely off screen', () => {
    expect(rectOnScreen(held, { x: 0, y: 0, w: 10, h: 10 })).toBeNull()
  })
})

describe('canvasPixelAt', () => {
  it('maps a device pixel back onto the canvas through a drawn tile', () => {
    const held = frame({ width: 800, height: 600 }, [
      { tile: { x: 10, y: 20 }, x: 100, y: 50, width: TILE_SIZE / 2, height: TILE_SIZE / 2 },
    ])
    expect(canvasPixelAt(held, 105, 70)).toEqual({ x: 10 * TILE_SIZE + 10, y: 20 * TILE_SIZE + 40 })
    expect(canvasPixelAt(held, 99, 50)).toEqual({ x: 10 * TILE_SIZE - 2, y: 20 * TILE_SIZE })
    expect(canvasPixelAt(frame({ width: 800, height: 600 }, []), 1, 1)).toBeNull()
  })
})
