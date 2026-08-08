export type Shortcut = 'toggle-colour' | 'toggle-markers' | 'toggle-panel' | 'toggle-template-menu'

/**
 * Whether a keystroke belongs to something else on the page.
 *
 * Kept DOM-shape based so the shortcut matcher stays testable without constructing a browser
 * document. Real keyboard event targets expose exactly these two properties.
 */
const isTyping = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false
  const element = target as EventTarget & { isContentEditable?: boolean; tagName?: unknown }
  if (element.isContentEditable === true) return true
  if (typeof element.tagName !== 'string') return false
  return (
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
  )
}

/** Resolve an unmodified, non-typing keydown to one of Caelestis's deliberately few shortcuts. */
export const shortcutFor = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'target'>,
): Shortcut | null => {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (isTyping(event.target)) return null

  switch (event.key.toLowerCase()) {
    case 'c':
      return 'toggle-panel'
    case 's':
      return 'toggle-colour'
    case 't':
      return 'toggle-template-menu'
    case 'w':
      return 'toggle-markers'
    default:
      return null
  }
}
