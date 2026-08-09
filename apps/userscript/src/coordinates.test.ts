import { describe, expect, it } from 'vitest'
import {
  canvasPixelAtIn,
  pixelsPerCanvasPixelIn,
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

  it('reports the current horizontal pixel scale and the no-frame fallback', () => {
    expect(pixelsPerCanvasPixelIn(frame())).toBe(0.2)
    expect(pixelsPerCanvasPixelIn(null)).toBe(1)
  })
})
