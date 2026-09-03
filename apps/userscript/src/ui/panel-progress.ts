/** Whether any coalesced native write belongs to the active artboard. */
export const canvasWritesTouchFrame = (
  frame: HTMLElement,
  writes: ReadonlySet<object>,
): boolean => {
  for (const canvas of writes) {
    try {
      if (frame.contains(canvas as Node)) return true
    } catch {
      // Foreign-realm and offscreen canvases do not belong to this artboard.
    }
  }
  return false
}
