import { describe, expect, it } from 'vitest'
import {
  canvasPixelAtIn,
  cssPixelsPerCanvasPixelIn,
  screenPointForIn,
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
    expect(cssPixelsPerCanvasPixelIn(frame())).toBe(0.1)
    expect(cssPixelsPerCanvasPixelIn(null)).toBe(1)
  })
})
