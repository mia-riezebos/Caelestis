interface ArtboardCanvasOwner {
  readonly stage: HTMLElement
  readonly frame: HTMLElement
}

/** Whether one native write changes committed art or explicit transparent-draft presence. */
export const canvasWriteTouchesArtboard = (
  active: ArtboardCanvasOwner,
  canvas: object,
): boolean => {
  try {
    const node = canvas as Node
    if (active.frame.contains(node)) return true
    const element = canvas as Element
    return (
      active.stage.contains(node) &&
      element.classList?.contains('paint-crosshair-tile') === true &&
      element.parentElement?.classList.contains('paint-crosshair-layer') === true
    )
  } catch {
    // Foreign-realm and offscreen canvases do not belong to this artboard.
    return false
  }
}

/** Whether any coalesced native write belongs to the active artboard. */
export const canvasWritesTouchArtboard = (
  active: ArtboardCanvasOwner,
  writes: ReadonlySet<object>,
): boolean => {
  for (const canvas of writes) {
    if (canvasWriteTouchesArtboard(active, canvas)) return true
  }
  return false
}
