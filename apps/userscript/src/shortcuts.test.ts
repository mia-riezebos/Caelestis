import { describe, expect, it } from 'vitest'
import { shortcutFor, shortcutPlatformFor } from './shortcuts.js'

const keydown = (
  key: string,
  overrides: Partial<Parameters<typeof shortcutFor>[0]> = {},
): Parameters<typeof shortcutFor>[0] => ({
  altKey: false,
  code: '',
  ctrlKey: false,
  key,
  metaKey: false,
  target: null,
  ...overrides,
})

describe('shortcutFor', () => {
  it.each([
    ['1', 'set-opacity-20'],
    ['2', 'set-opacity-40'],
    ['3', 'set-opacity-60'],
    ['4', 'set-opacity-80'],
    ['5', 'set-opacity-100'],
    ['b', 'toggle-paint'],
    ['c', 'toggle-panel'],
    ['C', 'toggle-panel'],
    ['d', 'cycle-colour-next'],
    ['f', 'fly-to-colour'],
    ['g', 'peek-overlays'],
    ['r', 'toggle-rings'],
    ['a', 'cycle-colour-previous'],
    ['s', 'toggle-colour'],
    ['t', 'toggle-template-menu'],
    ['T', 'toggle-template-menu'],
    ['v', 'toggle-visibility'],
    ['V', 'toggle-visibility'],
    ['w', 'toggle-markers'],
    ['x', 'toggle-selected-colour-markers'],
  ])('maps %s to %s', (key, expected) => {
    expect(shortcutFor(keydown(key))).toBe(expected)
  })

  it('does not claim modified keys or typing targets', () => {
    expect(shortcutFor(keydown('c', { metaKey: true }))).toBeNull()
    const input = Object.assign(new EventTarget(), { tagName: 'INPUT' })
    expect(shortcutFor(keydown('t', { target: input }))).toBeNull()
    expect(shortcutFor(keydown('f', { repeat: true }))).toBeNull()
  })

  it('uses only Cmd for repeatable undo and redo on macOS', () => {
    expect(shortcutFor(keydown('z', { metaKey: true }), 'mac')).toBe('undo-paint')
    expect(shortcutFor(keydown('z', { metaKey: true, repeat: true }), 'mac')).toBe('undo-paint')
    expect(shortcutFor(keydown('Z', { metaKey: true, repeat: true, shiftKey: true }), 'mac')).toBe(
      'redo-paint',
    )
    expect(shortcutFor(keydown('z', { ctrlKey: true }), 'mac')).toBeNull()
    expect(shortcutFor(keydown('z', { ctrlKey: true, metaKey: true }), 'mac')).toBeNull()
  })

  it('uses only Ctrl for repeatable undo and redo on Windows and Linux', () => {
    expect(shortcutFor(keydown('z', { ctrlKey: true }), 'windows-linux')).toBe('undo-paint')
    expect(
      shortcutFor(keydown('Z', { ctrlKey: true, repeat: true, shiftKey: true }), 'windows-linux'),
    ).toBe('redo-paint')
    expect(shortcutFor(keydown('z', { metaKey: true }), 'windows-linux')).toBeNull()
    expect(shortcutFor(keydown('z', { ctrlKey: true, metaKey: true }), 'windows-linux')).toBeNull()
  })

  it('does not claim undo while typing or with mixed modifiers', () => {
    const textarea = Object.assign(new EventTarget(), { tagName: 'TEXTAREA' })
    expect(
      shortcutFor(keydown('z', { ctrlKey: true, target: textarea }), 'windows-linux'),
    ).toBeNull()
    expect(shortcutFor(keydown('z', { altKey: true, ctrlKey: true }), 'windows-linux')).toBeNull()
    expect(shortcutFor(keydown('r', { repeat: true }))).toBeNull()
  })

  it('maps the physical help keys even when the layout reports a dead key', () => {
    expect(shortcutFor(keydown('Dead', { code: 'Slash', shiftKey: true }))).toBe(
      'show-shortcut-help',
    )
    expect(shortcutFor(keydown('Dead', { code: 'Backquote' }))).toBe('show-shortcut-help')
    expect(shortcutFor(keydown('?', { code: 'Quote', shiftKey: true }))).toBeNull()
    expect(shortcutFor(keydown('`', { code: 'Backquote', shiftKey: true }))).toBeNull()
  })
})

describe('shortcutPlatformFor', () => {
  it.each(['MacIntel', 'macOS', 'iPhone', 'iPad'])(
    'treats %s as a Mac command keyboard',
    (platform) => {
      expect(shortcutPlatformFor({ platform })).toBe('mac')
    },
  )

  it.each(['Win32', 'Windows', 'Linux x86_64', 'FreeBSD'])(
    'treats %s as Ctrl-based',
    (platform) => {
      expect(shortcutPlatformFor({ platform })).toBe('windows-linux')
    },
  )

  it('prefers user-agent client hints when available', () => {
    expect(shortcutPlatformFor({ platform: 'Win32', userAgentData: { platform: 'macOS' } })).toBe(
      'mac',
    )
  })
})
