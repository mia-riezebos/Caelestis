/**
 * Caelestis keyboard actions and the chords that trigger them.
 *
 * Bindings live here rather than in the userscript because the settings and shortcut-help UI need
 * the same vocabulary: which actions exist, what their default chords are, how a chord is written
 * out, and which physical keys it lights up on a keyboard map.
 *
 * **Two ways to identify a key.** A default binding names a `key` (the character or name the
 * layout reports) so it behaves the way it always has on every layout. A binding the user records
 * carries the physical `code` of the key they pressed and matches by that, so the trigger stays on
 * that key even when a shifted or dead-key layout reports a different character. The recorded
 * `key` is kept only for the label.
 */
export const SHORTCUT_IDS = [
  'cycle-colour-previous',
  'cycle-colour-next',
  'paint-action',
  'cancel-paint',
  'fly-to-colour',
  'peek-overlays',
  'undo-paint',
  'redo-paint',
  'toggle-panel',
  'toggle-theme',
  'toggle-rings',
  'toggle-colour',
  'toggle-template-menu',
  'toggle-visibility',
  'toggle-markers',
  'toggle-selected-colour-markers',
  'set-opacity-20',
  'set-opacity-40',
  'set-opacity-60',
  'set-opacity-80',
  'set-opacity-100',
  'show-shortcut-help',
] as const

export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export type ShortcutPlatform = 'mac' | 'windows-linux'

export interface KeyBinding {
  /**
   * `KeyboardEvent.key`, with single characters lowercased. Empty when the layout reported no
   * character (a dead key), in which case `code` carries the identity.
   */
  readonly key: string
  /** `KeyboardEvent.code`. Empty on default bindings, which match by `key`. */
  readonly code: string
  /** The platform command key: Cmd on macOS, Ctrl elsewhere. */
  readonly command: boolean
  readonly shift: boolean
  readonly alt: boolean
}

/** Every chord that triggers an action. Empty means the action has no key. */
export type ShortcutBindings = Readonly<Record<ShortcutId, readonly KeyBinding[]>>

/** Actions the user changed. Absent actions keep their default chords. */
export type ShortcutOverrides = Readonly<Partial<Record<ShortcutId, readonly KeyBinding[]>>>

const chord = (
  key: string,
  modifiers: Partial<Omit<KeyBinding, 'key' | 'code'>> = {},
): KeyBinding =>
  Object.freeze({ key, code: '', command: false, shift: false, alt: false, ...modifiers })

const physical = (
  code: string,
  modifiers: Partial<Omit<KeyBinding, 'key' | 'code'>> = {},
): KeyBinding =>
  Object.freeze({ key: '', code, command: false, shift: false, alt: false, ...modifiers })

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = Object.freeze({
  'cycle-colour-previous': [chord('a')],
  'cycle-colour-next': [chord('d')],
  'paint-action': [chord('b')],
  'cancel-paint': [chord('Escape')],
  'fly-to-colour': [chord('f')],
  'peek-overlays': [chord('g')],
  'undo-paint': [chord('z', { command: true })],
  'redo-paint': [chord('z', { command: true, shift: true })],
  'toggle-panel': [chord('c')],
  'toggle-theme': [chord('l')],
  'toggle-rings': [chord('r')],
  'toggle-colour': [chord('s')],
  'toggle-template-menu': [chord('t')],
  'toggle-visibility': [chord('v')],
  'toggle-markers': [chord('w')],
  'toggle-selected-colour-markers': [chord('x')],
  'set-opacity-20': [chord('1')],
  'set-opacity-40': [chord('2')],
  'set-opacity-60': [chord('3')],
  'set-opacity-80': [chord('4')],
  'set-opacity-100': [chord('5')],
  // Physical positions: layouts with dead keys report `key: 'Dead'` for `?` and `` ` `` while the
  // codes still identify the requested keys exactly.
  'show-shortcut-help': [physical('Backquote'), physical('Slash', { shift: true })],
})

/** Holding the chord repeats the action. Every other action fires once per press. */
export const REPEATING_SHORTCUTS: ReadonlySet<ShortcutId> = new Set(['undo-paint', 'redo-paint'])

const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
  'OS',
])

const UNKNOWN_KEYS = new Set(['', 'Dead', 'Unidentified', 'Process'])

const normaliseKey = (key: string): string => {
  if (UNKNOWN_KEYS.has(key)) return ''
  return key.length === 1 ? key.toLowerCase() : key
}

export interface KeyStrokeSource {
  readonly key: string
  readonly code: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey?: boolean
}

/**
 * Read one keydown as a chord, or nothing when it cannot be one: a bare modifier, or a stroke
 * holding the other platform's command key, which belongs to the browser or Wplace.
 */
export const keyBindingFromStroke = (
  stroke: KeyStrokeSource,
  platform: ShortcutPlatform,
): KeyBinding | null => {
  if (MODIFIER_KEYS.has(stroke.key)) return null
  const command = platform === 'mac' ? stroke.metaKey : stroke.ctrlKey
  const foreignCommand = platform === 'mac' ? stroke.ctrlKey : stroke.metaKey
  if (foreignCommand) return null
  const key = normaliseKey(stroke.key)
  const code = typeof stroke.code === 'string' ? stroke.code : ''
  if (key === '' && code === '') return null
  return { key, code, command, shift: stroke.shiftKey === true, alt: stroke.altKey }
}

const sameModifiers = (a: KeyBinding, b: KeyBinding): boolean =>
  a.command === b.command && a.shift === b.shift && a.alt === b.alt

/** Whether a pressed chord triggers a binding. Recorded bindings match by physical key. */
export const keyBindingMatches = (binding: KeyBinding, pressed: KeyBinding): boolean => {
  if (!sameModifiers(binding, pressed)) return false
  if (binding.code !== '') return binding.code === pressed.code
  return binding.key !== '' && binding.key === pressed.key
}

/** Whether a released key ends a held binding, whatever modifiers are still down. */
export const keyBindingReleasedBy = (
  binding: KeyBinding,
  released: Pick<KeyStrokeSource, 'key' | 'code'>,
): boolean =>
  binding.code !== ''
    ? binding.code === released.code
    : binding.key !== '' && binding.key === normaliseKey(released.key)

/** Whether two bindings would claim the same stroke, so both cannot stay assigned. */
export const sameKeyBinding = (a: KeyBinding, b: KeyBinding): boolean =>
  sameModifiers(a, b) && ((a.code !== '' && a.code === b.code) || (a.key !== '' && a.key === b.key))

const MAX_KEY_LENGTH = 32
const CODE_PATTERN = /^[A-Za-z0-9]*$/

/** Accept one stored chord, or nothing when it is not one this version understands. */
export const normaliseKeyBinding = (value: unknown): KeyBinding | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const key = typeof candidate.key === 'string' ? normaliseKey(candidate.key) : ''
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  if (key.length > MAX_KEY_LENGTH || code.length > MAX_KEY_LENGTH || !CODE_PATTERN.test(code)) {
    return null
  }
  if (key === '' && code === '') return null
  return {
    key,
    code,
    command: candidate.command === true,
    shift: candidate.shift === true,
    alt: candidate.alt === true,
  }
}

const MAX_BINDINGS_PER_SHORTCUT = 4

/** Accept stored overrides, dropping unknown actions and unreadable chords. */
export const normaliseShortcutOverrides = (value: unknown): ShortcutOverrides => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const stored = value as Record<string, unknown>
  const overrides: Partial<Record<ShortcutId, readonly KeyBinding[]>> = {}
  for (const id of SHORTCUT_IDS) {
    const entry = stored[id]
    if (!Array.isArray(entry)) continue
    const bindings: KeyBinding[] = []
    for (const candidate of entry) {
      const binding = normaliseKeyBinding(candidate)
      if (binding !== null && !bindings.some((other) => sameKeyBinding(other, binding))) {
        bindings.push(binding)
      }
      if (bindings.length >= MAX_BINDINGS_PER_SHORTCUT) break
    }
    overrides[id] = bindings
  }
  return overrides
}

export const resolveShortcutBindings = (overrides: ShortcutOverrides = {}): ShortcutBindings => {
  const resolved = {} as Record<ShortcutId, readonly KeyBinding[]>
  for (const id of SHORTCUT_IDS) resolved[id] = overrides[id] ?? DEFAULT_SHORTCUT_BINDINGS[id]
  return resolved
}

const sameBindingList = (a: readonly KeyBinding[], b: readonly KeyBinding[]): boolean =>
  a.length === b.length &&
  a.every((binding, index) => sameKeyBinding(binding, b[index] as KeyBinding))

/**
 * Give an action one chord, or none. Any other action holding that chord loses it, so a stroke can
 * never fire twice; the caller tells the user which ones were displaced.
 */
export const assignShortcutBinding = (
  overrides: ShortcutOverrides,
  id: ShortcutId,
  binding: KeyBinding | null,
): { readonly overrides: ShortcutOverrides; readonly displaced: readonly ShortcutId[] } => {
  const resolved = resolveShortcutBindings(overrides)
  const next: Partial<Record<ShortcutId, readonly KeyBinding[]>> = { ...overrides }
  const displaced: ShortcutId[] = []
  if (binding !== null) {
    for (const other of SHORTCUT_IDS) {
      if (other === id) continue
      const remaining = resolved[other].filter((candidate) => !sameKeyBinding(candidate, binding))
      if (remaining.length === resolved[other].length) continue
      displaced.push(other)
      if (sameBindingList(remaining, DEFAULT_SHORTCUT_BINDINGS[other])) delete next[other]
      else next[other] = remaining
    }
  }
  const bindings = binding === null ? [] : [binding]
  if (sameBindingList(bindings, DEFAULT_SHORTCUT_BINDINGS[id])) delete next[id]
  else next[id] = bindings
  return { overrides: next, displaced }
}

/** Codes for keys whose reported character has a dedicated physical key on a US layout. */
const CODE_BY_CHARACTER: Readonly<Record<string, string>> = {
  ' ': 'Space',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
}

const CHARACTER_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_BY_CHARACTER).map(([character, code]) => [code, character]),
)

const KEY_LEGENDS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backspace: 'Backspace',
  Delete: 'Del',
  Escape: 'Esc',
  Insert: 'Ins',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
}

const legendForCode = (code: string): string => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`
  const character = CHARACTER_BY_CODE[code]
  if (character !== undefined) return KEY_LEGENDS[character] ?? character
  return KEY_LEGENDS[code] ?? code
}

const legendForKey = (key: string): string => {
  if (key.length === 1) return KEY_LEGENDS[key] ?? key.toUpperCase()
  return KEY_LEGENDS[key] ?? key
}

const modifierLegends = (binding: KeyBinding, platform: ShortcutPlatform): string[] => {
  const legends: string[] = []
  if (binding.command) legends.push(platform === 'mac' ? 'Cmd' : 'Ctrl')
  if (binding.alt) legends.push(platform === 'mac' ? 'Opt' : 'Alt')
  if (binding.shift) legends.push('Shift')
  return legends
}

/** Write a chord the way the help and settings show it: `Cmd+Shift+Z`. */
export const keyBindingLabel = (binding: KeyBinding, platform: ShortcutPlatform): string =>
  [
    ...modifierLegends(binding, platform),
    binding.key !== '' ? legendForKey(binding.key) : legendForCode(binding.code),
  ].join('+')

/** Every physical key a chord holds down, for lighting up a keyboard map. */
export const keyBindingCodes = (binding: KeyBinding, platform: ShortcutPlatform): string[] => {
  const codes: string[] = []
  if (binding.command) codes.push(platform === 'mac' ? 'MetaLeft' : 'ControlLeft')
  if (binding.alt) codes.push('AltLeft')
  if (binding.shift) codes.push('ShiftLeft')
  if (binding.code !== '') codes.push(binding.code)
  else if (/^[a-z]$/.test(binding.key)) codes.push(`Key${binding.key.toUpperCase()}`)
  else if (/^[0-9]$/.test(binding.key)) codes.push(`Digit${binding.key}`)
  else codes.push(CODE_BY_CHARACTER[binding.key] ?? binding.key)
  return codes
}

/** Join every chord of an action: `` ` or Shift+/ ``. Empty when the action has no key. */
export const shortcutLabel = (
  bindings: readonly KeyBinding[],
  platform: ShortcutPlatform,
): string => bindings.map((binding) => keyBindingLabel(binding, platform)).join(' or ')
