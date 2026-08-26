import { describe, expect, it, vi } from 'vitest'
import {
  canvasPixelAtIn,
  createScreenProjectionCache,
  cssPixelsPerCanvasPixelIn,
  screenPointForIn,
  screenProjectionIn,
  viewportCentreIn,
} from './coordinates.js'
import type { TileFrame } from './tile-transform.js'

const frame = (): TileFrame => {
  const box = { left: 10, top: 20, width: 500, height: 250 }
  const canvas = {
    width: 1000,
    height: 1000,
    getBoundingClientRect: () => box,
  } as unknown as HTMLCanvasElement
  return {
    canvas,
    quads: [{ tile: { x: 2, y: 3 }, x: 400, y: 399, width: 200, height: 202 }],
  }
}

describe('overlay coordinates', () => {
  it('maps the viewport centre with independent axis scales', () => {
    expect(viewportCentreIn(frame())).toEqual({ x: 2500, y: 3500 })
  })

  it('round-trips canvas and screen coordinates with non-uniform CSS and quad scales', () => {
    const current = frame()
    const canvasPoint = { x: 2250, y: 3250 }
    const screen = screenPointForIn(current, canvasPoint.x, canvasPoint.y)

    expect(screen).not.toBeNull()
    expect(canvasPixelAtIn(current, screen?.x ?? 0, screen?.y ?? 0)).toEqual(canvasPoint)
  })

  it('extrapolates the viewport centre through a temporarily missing tile', () => {
    const canvas = {
      width: 1000,
      height: 500,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    } as unknown as HTMLCanvasElement
    const current: TileFrame = {
      canvas,
      quads: [{ tile: { x: 10, y: 20 }, x: 0, y: 0, width: 100, height: 100 }],
    }

    expect(viewportCentreIn(current)).toEqual({ x: 15_000, y: 22_500 })
  })

  it('projects canonical x coordinates across the antimeridian', () => {
    const canvas = {
      width: 1000,
      height: 500,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    } as unknown as HTMLCanvasElement
    const current: TileFrame = {
      canvas,
      quads: [
        { tile: { x: 2047, y: 1000 }, x: -100, y: 0, width: 500, height: 500 },
        { tile: { x: 0, y: 1000 }, x: 400, y: 0, width: 500, height: 500 },
      ],
    }

    expect(screenPointForIn(current, 500, 1_000_500)).toEqual({ x: 650, y: 250 })
  })

  it('declines coordinate conversion while the canvas has no CSS size', () => {
    const current = frame()
    current.canvas.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 0,
      height: 0,
      right: 10,
      bottom: 20,
      x: 10,
      y: 20,
      toJSON: () => undefined,
    })

    expect(canvasPixelAtIn(current, 10, 20)).toBeNull()
    expect(screenPointForIn(current, 2_250, 3_250)).toBeNull()
  })

  it('reports CSS pixels per canvas pixel without double-counting device pixel ratio', () => {
    expect(cssPixelsPerCanvasPixelIn(frame())).toEqual({ x: 0.1, y: 0.0505 })
    expect(cssPixelsPerCanvasPixelIn(null)).toEqual({ x: 1, y: 1 })
  })

  it('shares one layout read across a batch of projected points and its scale', () => {
    const current = frame()
    const readRect = current.canvas.getBoundingClientRect
    current.canvas.getBoundingClientRect = vi.fn(readRect)

    const projection = screenProjectionIn(current)
    projection?.pointFor(2_250, 3_250)
    projection?.pointFor(2_500, 3_500)
    void projection?.pixelsPerCanvasPixel

    expect(current.canvas.getBoundingClientRect).toHaveBeenCalledTimes(1)
  })

  it('does not force canvas layout again while only map pixels move', () => {
    const current = frame()
    const readRect = current.canvas.getBoundingClientRect
    current.canvas.getBoundingClientRect = vi.fn(readRect)
    const cache = createScreenProjectionCache()

    cache.project(current)?.pointFor(2_250, 3_250)
    const moved: TileFrame = {
      ...current,
      quads: current.quads.map((quad) => ({ ...quad, x: quad.x + 50 })),
    }
    cache.project(moved)?.pointFor(2_250, 3_250)

    expect(current.canvas.getBoundingClientRect).toHaveBeenCalledTimes(1)
    cache.dispose()
  })

  it('remeasures canvas layout when its backing size changes', () => {
    const current = frame()
    const readRect = current.canvas.getBoundingClientRect
    current.canvas.getBoundingClientRect = vi.fn(readRect)
    const cache = createScreenProjectionCache()

    cache.project(current)
    current.canvas.width = 2_000
    cache.project(current)

    expect(current.canvas.getBoundingClientRect).toHaveBeenCalledTimes(2)
    cache.dispose()
  })
})
