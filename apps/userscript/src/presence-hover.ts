/**
 * Which region claims the pointer is over right now. The name tags find them each frame; the
 * presence layer reads them to let your own claim's fill step aside while you paint inside it.
 * A tiny module of its own so neither side has to import the other.
 */

let hovered: ReadonlySet<string> = new Set()
const listeners: (() => void)[] = []

export const hoveredPresenceRegions = (): ReadonlySet<string> => hovered

/** Replace the hovered set; listeners run only when it actually changed. */
export const setHoveredPresenceRegions = (ids: ReadonlySet<string>): void => {
  if (ids.size === hovered.size && [...ids].every((id) => hovered.has(id))) return
  hovered = new Set(ids)
  for (const listener of listeners) listener()
}

export const onPresenceHoverChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** Test seam. */
export const resetPresenceHover = (): void => {
  hovered = new Set()
  listeners.length = 0
}
