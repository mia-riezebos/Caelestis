import {
  KEY_CAPTURE_ATTRIBUTE,
  keyBindingFromStroke,
  keyBindingMatches,
  REPEATING_SHORTCUTS,
  resolveShortcutBindings,
  SHORTCUT_IDS,
  type ShortcutBindings,
  type ShortcutId,
  type ShortcutPlatform,
} from '@caelestis/shared'

export type Shortcut = ShortcutId
export type { ShortcutPlatform }

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

export { KEY_CAPTURE_ATTRIBUTE }

/**
 * Whether a keystroke belongs to something else on the page.
 *
 * Kept DOM-shape based so the shortcut matcher stays testable without constructing a browser
 * document. Real keyboard event targets expose exactly these properties.
 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false
  const element = target as EventTarget & {
    isContentEditable?: boolean
    tagName?: unknown
    getAttribute?: (name: string) => string | null
  }
  if (element.isContentEditable === true) return true
  if (
    typeof element.getAttribute === 'function' &&
    element.getAttribute(KEY_CAPTURE_ATTRIBUTE) !== null
  ) {
    return true
  }
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

const DEFAULT_BINDINGS = resolveShortcutBindings()

/**
 * Resolve a non-typing keydown to one of Caelestis's deliberately few shortcuts.
 *
 * Actions are tried in a fixed order and the first match wins, so a chord can never fire two of
 * them even if stored bindings somehow overlap.
 */
export const shortcutFor = (
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'target'> &
    Partial<Pick<KeyboardEvent, 'composedPath' | 'repeat' | 'shiftKey'>>,
  platform = currentShortcutPlatform(),
  bindings: ShortcutBindings = DEFAULT_BINDINGS,
): Shortcut | null => {
  if (isTypingEvent(event)) return null
  const pressed = keyBindingFromStroke(event, platform)
  if (pressed === null) return null
  for (const id of SHORTCUT_IDS) {
    if (!bindings[id].some((binding) => keyBindingMatches(binding, pressed))) continue
    // Repeats are intentional for undo and redo: holding the chord walks Wplace's per-pixel
    // history. Every other shortcut remains single-shot.
    if (event.repeat === true && !REPEATING_SHORTCUTS.has(id)) return null
    return id
  }
  return null
}
