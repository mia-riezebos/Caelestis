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

export const announceCanvasWrite = (canvas: object, dirty: CanvasWriteRect | null = null): void => {
  for (const listener of listeners) listener(canvas, dirty)
}
