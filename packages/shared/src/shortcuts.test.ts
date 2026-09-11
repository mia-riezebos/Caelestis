import { describe, expect, it } from 'vitest'
import {
  assignShortcutBinding,
  DEFAULT_SHORTCUT_BINDINGS,
  type KeyBinding,
  keyBindingCodes,
  keyBindingFromStroke,
  keyBindingLabel,
  keyBindingMatches,
  keyBindingReleasedBy,
  normaliseShortcutOverrides,
  resolveShortcutBindings,
  SHORTCUT_IDS,
  shortcutLabel,
} from './shortcuts.js'

const stroke = (
  key: string,
  overrides: Partial<Parameters<typeof keyBindingFromStroke>[0]> = {},
): Parameters<typeof keyBindingFromStroke>[0] => ({
  key,
  code: '',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

const recorded = (key: string, code: string, modifiers: Partial<KeyBinding> = {}): KeyBinding => ({
  key,
  code,
  command: false,
  shift: false,
  alt: false,
  ...modifiers,
})

describe('keyBindingFromStroke', () => {
  it('lowercases characters and keeps the physical code', () => {
    expect(keyBindingFromStroke(stroke('A', { code: 'KeyQ', shiftKey: true }), 'mac')).toEqual({
      key: 'a',
      code: 'KeyQ',
      command: false,
      shift: true,
      alt: false,
    })
  })

  it('reads the platform command key and rejects the other one', () => {
    expect(keyBindingFromStroke(stroke('z', { metaKey: true }), 'mac')?.command).toBe(true)
    expect(keyBindingFromStroke(stroke('z', { ctrlKey: true }), 'windows-linux')?.command).toBe(
      true,
    )
    expect(keyBindingFromStroke(stroke('z', { ctrlKey: true }), 'mac')).toBeNull()
    expect(keyBindingFromStroke(stroke('z', { metaKey: true }), 'windows-linux')).toBeNull()
  })

  it('ignores bare modifiers and strokes without any identity', () => {
    expect(
      keyBindingFromStroke(stroke('Shift', { code: 'ShiftLeft', shiftKey: true }), 'mac'),
    ).toBeNull()
    expect(keyBindingFromStroke(stroke('Dead'), 'mac')).toBeNull()
    expect(keyBindingFromStroke(stroke('Dead', { code: 'Slash' }), 'mac')?.key).toBe('')
  })
})

describe('keyBindingMatches', () => {
  const [previousColour] = DEFAULT_SHORTCUT_BINDINGS['cycle-colour-previous']
  const [help, helpChord] = DEFAULT_SHORTCUT_BINDINGS['show-shortcut-help']

  it('matches default bindings by reported key on any layout', () => {
    const pressed = keyBindingFromStroke(stroke('a', { code: 'KeyQ' }), 'mac')
    expect(pressed !== null && keyBindingMatches(previousColour as KeyBinding, pressed)).toBe(true)
    const shifted = keyBindingFromStroke(stroke('A', { code: 'KeyA', shiftKey: true }), 'mac')
    expect(shifted !== null && keyBindingMatches(previousColour as KeyBinding, shifted)).toBe(false)
  })

  it('matches physical defaults by code even when the layout reports a dead key', () => {
    const dead = keyBindingFromStroke(stroke('Dead', { code: 'Backquote' }), 'mac')
    expect(dead !== null && keyBindingMatches(help as KeyBinding, dead)).toBe(true)
    const question = keyBindingFromStroke(stroke('?', { code: 'Slash', shiftKey: true }), 'mac')
    expect(question !== null && keyBindingMatches(helpChord as KeyBinding, question)).toBe(true)
    const quote = keyBindingFromStroke(stroke('?', { code: 'Quote', shiftKey: true }), 'mac')
    expect(quote !== null && keyBindingMatches(helpChord as KeyBinding, quote)).toBe(false)
  })

  it('matches recorded bindings by the physical key that was pressed', () => {
    const binding = recorded('a', 'KeyQ')
    const samePosition = keyBindingFromStroke(stroke('q', { code: 'KeyQ' }), 'mac')
    const sameCharacter = keyBindingFromStroke(stroke('a', { code: 'KeyA' }), 'mac')
    expect(samePosition !== null && keyBindingMatches(binding, samePosition)).toBe(true)
    expect(sameCharacter !== null && keyBindingMatches(binding, sameCharacter)).toBe(false)
  })

  it('releases a held binding whatever modifiers remain down', () => {
    expect(
      keyBindingReleasedBy(recorded('g', 'KeyG', { shift: true }), { key: 'g', code: 'KeyG' }),
    ).toBe(true)
    expect(keyBindingReleasedBy(recorded('g', ''), { key: 'G', code: 'KeyG' })).toBe(true)
    expect(keyBindingReleasedBy(recorded('g', ''), { key: 'h', code: 'KeyH' })).toBe(false)
  })
})

describe('shortcut overrides', () => {
  it('resolves missing actions to their defaults and empty lists to no key', () => {
    const bindings = resolveShortcutBindings({ 'toggle-panel': [] })
    expect(bindings['toggle-panel']).toEqual([])
    expect(bindings['toggle-theme']).toBe(DEFAULT_SHORTCUT_BINDINGS['toggle-theme'])
    expect(Object.keys(bindings)).toEqual([...SHORTCUT_IDS])
  })

  it('accepts only readable stored chords for known actions', () => {
    expect(
      normaliseShortcutOverrides({
        'toggle-panel': [
          { key: 'P', code: 'KeyP', shift: true },
          { key: 'P', code: 'KeyP', shift: true },
        ],
        'toggle-rings': [{ code: 'bad code!' }, null, 'x'],
        'not-an-action': [{ key: 'a' }],
        'toggle-theme': 'nope',
      }),
    ).toEqual({
      'toggle-panel': [{ key: 'p', code: 'KeyP', command: false, shift: true, alt: false }],
      'toggle-rings': [],
    })
    expect(normaliseShortcutOverrides(null)).toEqual({})
    expect(normaliseShortcutOverrides([])).toEqual({})
  })

  it('moves a chord off any other action that held it', () => {
    const { overrides, displaced } = assignShortcutBinding(
      {},
      'toggle-panel',
      recorded('d', 'KeyD'),
    )
    expect(displaced).toEqual(['cycle-colour-next'])
    expect(overrides).toEqual({
      'cycle-colour-next': [],
      'toggle-panel': [recorded('d', 'KeyD')],
    })
    const resolved = resolveShortcutBindings(overrides)
    const pressed = keyBindingFromStroke(stroke('d', { code: 'KeyD' }), 'mac') as KeyBinding
    expect(
      SHORTCUT_IDS.filter((id) => resolved[id].some((b) => keyBindingMatches(b, pressed))),
    ).toEqual(['toggle-panel'])
  })

  it('keeps the other chord of a two-chord default when only one is taken', () => {
    const { overrides, displaced } = assignShortcutBinding(
      {},
      'toggle-panel',
      recorded('`', 'Backquote'),
    )
    expect(displaced).toEqual(['show-shortcut-help'])
    expect(overrides['show-shortcut-help']).toEqual([
      DEFAULT_SHORTCUT_BINDINGS['show-shortcut-help'][1],
    ])
  })

  it('drops the override when an action returns to its default, and stores an unassignment', () => {
    const moved = assignShortcutBinding({}, 'toggle-panel', recorded('p', 'KeyP')).overrides
    expect(assignShortcutBinding(moved, 'toggle-panel', recorded('c', 'KeyC')).overrides).toEqual(
      {},
    )
    expect(assignShortcutBinding({}, 'toggle-panel', null).overrides).toEqual({
      'toggle-panel': [],
    })
  })
})

describe('labels and keyboard codes', () => {
  it('writes chords with platform modifier names', () => {
    const [redo] = DEFAULT_SHORTCUT_BINDINGS['redo-paint']
    expect(keyBindingLabel(redo as KeyBinding, 'mac')).toBe('Cmd+Shift+Z')
    expect(keyBindingLabel(redo as KeyBinding, 'windows-linux')).toBe('Ctrl+Shift+Z')
    expect(keyBindingLabel(recorded('k', 'KeyK', { alt: true }), 'mac')).toBe('Opt+K')
    expect(keyBindingLabel(recorded('Escape', ''), 'mac')).toBe('Esc')
    expect(keyBindingLabel(recorded('', 'Slash', { shift: true }), 'mac')).toBe('Shift+/')
    expect(keyBindingLabel(recorded(' ', 'Space'), 'mac')).toBe('Space')
    expect(shortcutLabel(DEFAULT_SHORTCUT_BINDINGS['show-shortcut-help'], 'mac')).toBe(
      '` or Shift+/',
    )
    expect(shortcutLabel([], 'mac')).toBe('')
  })

  it('lights every key a chord holds on the platform keyboard', () => {
    const [redo] = DEFAULT_SHORTCUT_BINDINGS['redo-paint']
    expect(keyBindingCodes(redo as KeyBinding, 'mac')).toEqual(['MetaLeft', 'ShiftLeft', 'KeyZ'])
    expect(keyBindingCodes(redo as KeyBinding, 'windows-linux')).toEqual([
      'ControlLeft',
      'ShiftLeft',
      'KeyZ',
    ])
    expect(keyBindingCodes(recorded('1', ''), 'mac')).toEqual(['Digit1'])
    expect(keyBindingCodes(recorded('Escape', ''), 'mac')).toEqual(['Escape'])
    expect(keyBindingCodes(recorded('a', 'KeyQ'), 'mac')).toEqual(['KeyQ'])
    expect(keyBindingCodes(recorded('/', ''), 'mac')).toEqual(['Slash'])
  })
})
