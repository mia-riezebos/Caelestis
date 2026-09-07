import { recordProfileCounter } from './profile.js'

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

/** Publish a successful observed canvas write, with a bounded dirty rectangle when known. */
export const announceCanvasWrite = (canvas: object, dirty: CanvasWriteRect | null = null): void => {
  recordProfileCounter('canvas:observed writes')
  if (dirty !== null) recordProfileCounter('canvas:written pixels', dirty.width * dirty.height)
  for (const listener of listeners) listener(canvas, dirty)
}
