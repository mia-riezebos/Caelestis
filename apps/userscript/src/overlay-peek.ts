/** Runtime-only hold-to-peek state. It must never mutate or persist template visibility. */

let active = false
const listeners = new Set<() => void>()

export const isOverlayPeekActive = (): boolean => active

export const onOverlayPeekChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Returns whether the render state actually changed. */
export const setOverlayPeekActive = (next: boolean): boolean => {
  if (active === next) return false
  active = next
  for (const listener of listeners) listener()
  return true
}
