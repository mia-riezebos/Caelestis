const listeners = new Set<(canvas: object) => void>()

/** Observe page-owned pixel canvas writes after the native operation succeeds. */
export const onCanvasWrite = (listener: (canvas: object) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const announceCanvasWrite = (canvas: object): void => {
  for (const listener of listeners) listener(canvas)
}
