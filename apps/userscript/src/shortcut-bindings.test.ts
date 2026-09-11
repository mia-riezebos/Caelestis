import type { ShortcutOverrides } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ overrides: {} as ShortcutOverrides }))

vi.mock('./state.js', () => ({
  getState: () => ({ shortcutOverrides: harness.overrides }),
}))

import { activeShortcutBindings, shortcutHint } from './shortcut-bindings.js'

beforeEach(() => {
  harness.overrides = {}
})

describe('active shortcut bindings', () => {
  it('resolves the stored overrides once per state object', () => {
    const first = activeShortcutBindings()
    expect(activeShortcutBindings()).toBe(first)
    expect(first['toggle-panel'][0]?.key).toBe('c')

    harness.overrides = { 'toggle-panel': [] }
    const second = activeShortcutBindings()
    expect(second).not.toBe(first)
    expect(second['toggle-panel']).toEqual([])
    expect(activeShortcutBindings()).toBe(second)
  })

  it('writes the tooltip hint from the active chord, or nothing without one', () => {
    expect(shortcutHint('toggle-panel', 'mac')).toBe(' (C)')
    expect(shortcutHint('redo-paint', 'windows-linux')).toBe(' (Ctrl+Shift+Z)')
    expect(shortcutHint('show-shortcut-help', 'mac')).toBe(' (` or Shift+/)')

    harness.overrides = {
      'toggle-panel': [{ key: 'p', code: 'KeyP', command: false, shift: true, alt: false }],
      'toggle-markers': [],
    }
    expect(shortcutHint('toggle-panel', 'mac')).toBe(' (Shift+P)')
    expect(shortcutHint('toggle-markers', 'mac')).toBe('')
  })
})
