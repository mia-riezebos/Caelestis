import { isProfileEnabled, recordProfileCounter } from './profile.js'

export interface CanvasWriteRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type CanvasWriteListener = (canvas: object, dirty: CanvasWriteRect | null) => void

const listeners = new Set<CanvasWriteListener>()

/** Observe page-owned pixel canvas writes after the native operation succeeds. */
export const onCanvasWrite = (listener: CanvasWriteListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Publish a successful observed canvas write; count known integer rectangles within canvas bounds. */
export const announceCanvasWrite = (
  canvas: { readonly width: number; readonly height: number },
  dirty: CanvasWriteRect | null = null,
): void => {
  recordProfileCounter('canvas:observed writes')
  if (
    isProfileEnabled() &&
    dirty !== null &&
    [dirty.x, dirty.y, dirty.width, dirty.height].every(Number.isInteger)
  ) {
    const left = Math.max(0, Math.min(dirty.x, dirty.x + dirty.width))
    const top = Math.max(0, Math.min(dirty.y, dirty.y + dirty.height))
    const right = Math.min(canvas.width, Math.max(dirty.x, dirty.x + dirty.width))
    const bottom = Math.min(canvas.height, Math.max(dirty.y, dirty.y + dirty.height))
    recordProfileCounter(
      'canvas:written pixels',
      Math.max(0, right - left) * Math.max(0, bottom - top),
    )
  }
  for (const listener of listeners) listener(canvas, dirty)
}
