/** Runtime-only hold-to-peek state. It must never mutate or persist template visibility. */

let active = false

export const isOverlayPeekActive = (): boolean => active

/** Returns whether the render state actually changed. */
export const setOverlayPeekActive = (next: boolean): boolean => {
  if (active === next) return false
  active = next
  return true
}
