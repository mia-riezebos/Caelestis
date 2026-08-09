import { TILE_SIZE, WORLD_PIXELS } from '@wts/shared'
import type { TileFrame } from './tile-transform.js'

const wrapWorldX = (x: number): number => ((x % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS

/** The nearest wrapped copy of a canonical x coordinate relative to an on-screen reference. */
const wrappedXDelta = (x: number, reference: number): number => {
  const delta = wrapWorldX(x) - wrapWorldX(reference)
  return (
    ((((delta + WORLD_PIXELS / 2) % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS) - WORLD_PIXELS / 2
  )
}

/** Where the middle of the viewport falls in wplace's global pixel coordinates. */
export const viewportCentreIn = (frame: TileFrame): { x: number; y: number } | null => {
  if (frame.quads.length === 0) return null
  const midX = frame.canvas.width / 2
  const midY = frame.canvas.height / 2
  for (const quad of frame.quads) {
    if (midX < quad.x || midX >= quad.x + quad.width) continue
    if (midY < quad.y || midY >= quad.y + quad.height) continue
    const scaleX = TILE_SIZE / quad.width
    const scaleY = TILE_SIZE / quad.height
    return {
      x: quad.tile.x * TILE_SIZE + (midX - quad.x) * scaleX,
      y: quad.tile.y * TILE_SIZE + (midY - quad.y) * scaleY,
    }
  }
  const first = frame.quads[0]
  if (first === undefined) return null
  return {
    x: wrapWorldX(first.tile.x * TILE_SIZE + ((midX - first.x) * TILE_SIZE) / first.width),
    y: first.tile.y * TILE_SIZE + ((midY - first.y) * TILE_SIZE) / first.height,
  }
}

/** Global canvas pixel under a browser client-coordinate point. */
export const canvasPixelAtIn = (
  frame: TileFrame,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const box = frame.canvas.getBoundingClientRect()
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const px = (clientX - box.left) * ratioX
  const py = (clientY - box.top) * ratioY
  for (const quad of frame.quads) {
    if (px < quad.x || px >= quad.x + quad.width) continue
    if (py < quad.y || py >= quad.y + quad.height) continue
    return {
      x: quad.tile.x * TILE_SIZE + ((px - quad.x) * TILE_SIZE) / quad.width,
      y: quad.tile.y * TILE_SIZE + ((py - quad.y) * TILE_SIZE) / quad.height,
    }
  }
  return null
}

/** Browser client-coordinate position of a global canvas pixel. */
export const screenPointForIn = (
  frame: TileFrame,
  x: number,
  y: number,
): { x: number; y: number } | null => {
  const reference = frame.quads[0]
  if (reference === undefined) return null
  const box = frame.canvas.getBoundingClientRect()
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const scaleX = reference.width / TILE_SIZE
  const scaleY = reference.height / TILE_SIZE
  const originX = reference.tile.x * TILE_SIZE
  const originY = reference.tile.y * TILE_SIZE
  return {
    x: box.left + (reference.x + wrappedXDelta(x, originX) * scaleX) / ratioX,
    y: box.top + (reference.y + (y - originY) * scaleY) / ratioY,
  }
}

/** Device pixels occupied by one wplace pixel in this frame. */
export const pixelsPerCanvasPixelIn = (frame: TileFrame | null): number => {
  const quad = frame?.quads[0]
  return quad === undefined ? 1 : quad.width / TILE_SIZE
}
