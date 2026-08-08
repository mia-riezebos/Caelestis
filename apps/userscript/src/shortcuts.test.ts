import { describe, expect, it } from 'vitest'
import { shortcutFor } from './shortcuts.js'

const keydown = (
  key: string,
  overrides: Partial<Parameters<typeof shortcutFor>[0]> = {},
): Parameters<typeof shortcutFor>[0] => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  target: null,
  ...overrides,
})

describe('shortcutFor', () => {
  it.each([
    ['c', 'toggle-panel'],
    ['C', 'toggle-panel'],
    ['s', 'toggle-colour'],
    ['t', 'toggle-template-menu'],
    ['T', 'toggle-template-menu'],
    ['w', 'toggle-markers'],
  ])('maps %s to %s', (key, expected) => {
    expect(shortcutFor(keydown(key))).toBe(expected)
  })

  it('does not claim modified keys or typing targets', () => {
    expect(shortcutFor(keydown('c', { metaKey: true }))).toBeNull()
    const input = Object.assign(new EventTarget(), { tagName: 'INPUT' })
    expect(shortcutFor(keydown('t', { target: input }))).toBeNull()
  })
})
