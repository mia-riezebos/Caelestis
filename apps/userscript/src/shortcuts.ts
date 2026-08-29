export type Shortcut =
  | 'cycle-colour-next'
  | 'cycle-colour-previous'
  | 'fly-to-colour'
  | 'peek-overlays'
  | 'show-shortcut-help'
  | 'set-opacity-100'
  | 'set-opacity-20'
  | 'set-opacity-40'
  | 'set-opacity-60'
  | 'set-opacity-80'
  | 'toggle-colour'
  | 'toggle-markers'
  | 'toggle-panel'
  | 'toggle-paint'
  | 'toggle-rings'
  | 'toggle-selected-colour-markers'
  | 'toggle-template-menu'
  | 'toggle-visibility'

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

/** Resolve a non-typing keydown to one of Caelestis's deliberately few shortcuts. */
export const shortcutFor = (
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'target'> &
    Partial<Pick<KeyboardEvent, 'repeat' | 'shiftKey'>>,
): Shortcut | null => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return null
  if (isTyping(event.target)) return null
  // Physical position is intentional: layouts with dead keys may report `key: 'Dead'` for `?`,
  // while `code: 'Slash'` still identifies the requested Shift+/ chord exactly.
  if (event.shiftKey) return event.code === 'Slash' ? 'show-shortcut-help' : null

  switch (event.key.toLowerCase()) {
    case '1':
      return 'set-opacity-20'
    case '2':
      return 'set-opacity-40'
    case '3':
      return 'set-opacity-60'
    case '4':
      return 'set-opacity-80'
    case '5':
      return 'set-opacity-100'
    case 'b':
      return 'toggle-paint'
    case 'c':
      return 'toggle-panel'
    case 'd':
      return 'cycle-colour-next'
    case 'f':
      return 'fly-to-colour'
    case 'g':
      return 'peek-overlays'
    case 'r':
      return 'toggle-rings'
    case 'a':
      return 'cycle-colour-previous'
    case 's':
      return 'toggle-colour'
    case 't':
      return 'toggle-template-menu'
    case 'v':
      return 'toggle-visibility'
    case 'w':
      return 'toggle-markers'
    case 'x':
      return 'toggle-selected-colour-markers'
    default:
      return null
  }
}
