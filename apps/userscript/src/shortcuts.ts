export type Shortcut =
  | 'cancel-paint'
  | 'cycle-colour-next'
  | 'cycle-colour-previous'
  | 'fly-to-colour'
  | 'peek-overlays'
  | 'paint-action'
  | 'redo-paint'
  | 'show-shortcut-help'
  | 'set-opacity-100'
  | 'set-opacity-20'
  | 'set-opacity-40'
  | 'set-opacity-60'
  | 'set-opacity-80'
  | 'toggle-colour'
  | 'toggle-markers'
  | 'toggle-panel'
  | 'toggle-rings'
  | 'toggle-selected-colour-markers'
  | 'toggle-template-menu'
  | 'toggle-theme'
  | 'toggle-visibility'
  | 'undo-paint'

export type ShortcutPlatform = 'mac' | 'windows-linux'

interface ShortcutPlatformSource {
  readonly platform?: string
  readonly userAgent?: string
  readonly userAgentData?: { readonly platform?: string }
}

/** Resolve the keyboard convention once without relying on the character produced by a key. */
export const shortcutPlatformFor = (source: ShortcutPlatformSource): ShortcutPlatform => {
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'windows-linux'
}

export const currentShortcutPlatform = (): ShortcutPlatform =>
  typeof navigator === 'undefined'
    ? 'windows-linux'
    : shortcutPlatformFor(navigator as Navigator & ShortcutPlatformSource)

/**
 * Whether a keystroke belongs to something else on the page.
 *
 * Kept DOM-shape based so the shortcut matcher stays testable without constructing a browser
 * document. Real keyboard event targets expose exactly these two properties.
 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false
  const element = target as EventTarget & { isContentEditable?: boolean; tagName?: unknown }
  if (element.isContentEditable === true) return true
  if (typeof element.tagName !== 'string') return false
  return (
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
  )
}

const isTypingEvent = (
  event: Pick<KeyboardEvent, 'target'> & Partial<Pick<KeyboardEvent, 'composedPath'>>,
): boolean =>
  isTypingTarget(event.target) ||
  event.composedPath?.().some((target) => isTypingTarget(target)) === true

/** Resolve a non-typing keydown to one of Caelestis's deliberately few shortcuts. */
export const shortcutFor = (
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'target'> &
    Partial<Pick<KeyboardEvent, 'composedPath' | 'repeat' | 'shiftKey'>>,
  platform = currentShortcutPlatform(),
): Shortcut | null => {
  if (isTypingEvent(event)) return null
  const command = platform === 'mac' ? event.metaKey : event.ctrlKey
  const foreignCommand = platform === 'mac' ? event.ctrlKey : event.metaKey
  if (command || foreignCommand) {
    if (!command || foreignCommand || event.altKey || event.key.toLowerCase() !== 'z') {
      return null
    }
    // Repeats are intentional here: holding the chord walks Wplace's per-pixel history. Every
    // other shortcut remains single-shot below.
    return event.shiftKey ? 'redo-paint' : 'undo-paint'
  }
  if (event.altKey || event.repeat) return null
  // Physical position is intentional: layouts with dead keys may report `key: 'Dead'` for `?`,
  // while `code: 'Slash'` still identifies the requested Shift+/ chord exactly.
  if (event.shiftKey) return event.code === 'Slash' ? 'show-shortcut-help' : null
  if (event.code === 'Backquote') return 'show-shortcut-help'

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
      return 'paint-action'
    case 'c':
      return 'toggle-panel'
    case 'd':
      return 'cycle-colour-next'
    case 'f':
      return 'fly-to-colour'
    case 'g':
      return 'peek-overlays'
    case 'l':
      return 'toggle-theme'
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
    case 'escape':
      return 'cancel-paint'
    default:
      return null
  }
}
