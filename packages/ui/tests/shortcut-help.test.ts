// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ShortcutHelp from '../src/shortcut-help/ShortcutHelp.svelte'
import type { ShortcutHelpPlatform } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())

const mountHelp = (platform: ShortcutHelpPlatform = 'mac', onIntent = vi.fn()) => {
  const component = mount(ShortcutHelp, {
    target: document.body,
    props: { model: { platform }, onIntent },
  })
  flushSync()
  return { component, onIntent }
}

describe('shortcut help', () => {
  it('renders the complete reference in a native dialog', () => {
    const { component } = mountHelp('mac')
    const dialog = document.querySelector<HTMLDialogElement>('dialog')

    expect(dialog?.open).toBe(true)
    expect(dialog?.textContent).toContain('Keyboard shortcuts')
    expect(dialog?.textContent).toContain('` or Shift+/')
    expect(dialog?.textContent).toContain('Open or commit paint draft')
    expect(dialog?.textContent).toContain('Cancel paint draft')
    expect(dialog?.textContent).toContain('Light / dark theme')
    expect(dialog?.textContent).toContain('Cmd+Shift+Z')
    expect(dialog?.textContent).toContain('Redo drafted pixel')
    expect(dialog?.textContent).toContain('Toggle contrast rings')
    expect(dialog?.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(14)
    expect(dialog?.querySelectorAll('.caelestis-shortcut-groups > section')).toHaveLength(2)
    expect(dialog?.querySelector('.caelestis-keymap')).not.toBeNull()
    expect(getComputedStyle(dialog?.querySelector('header') as Element).padding).toBe('16px 24px')

    void unmount(component)
  })

  it('emits one close intent from the button and backdrop', () => {
    const first = mountHelp()
    document.querySelector<HTMLButtonElement>('header button')?.click()
    expect(first.onIntent).toHaveBeenCalledWith({ type: 'close' })
    void unmount(first.component)

    const second = mountHelp()
    document
      .querySelector<HTMLDialogElement>('dialog')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(second.onIntent).toHaveBeenCalledWith({ type: 'close' })
    void unmount(second.component)
  })

  it('groups related keys and reveals their shared explanation on focus', () => {
    const { component } = mountHelp('mac')
    const map = document.querySelector<HTMLElement>('.caelestis-keymap')
    const previous = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyA"]')
    const next = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyD"]')
    const unused = map?.querySelector<HTMLElement>('[data-keyboard-key="KeyQ"]')

    expect(previous?.dataset.shortcutSet).toBe('colour-cycle')
    expect(next?.dataset.shortcutSet).toBe('colour-cycle')
    expect(unused).not.toBeInstanceOf(HTMLButtonElement)
    expect(
      ['Escape', 'Digit1', 'KeyQ', 'KeyA', 'KeyZ'].map(
        (code) =>
          map?.querySelector<HTMLElement>(`[data-keyboard-key="${code}"]`)?.dataset.keyUnits,
      ),
    ).toEqual(['1.25', '1', '1', '1', '1'])
    expect(map?.querySelector<HTMLElement>('[data-keyboard-key="Tab"]')?.dataset.keyUnits).toBe(
      '1.5',
    )
    expect(
      map?.querySelector<HTMLElement>('[data-keyboard-key="CapsLock"]')?.dataset.keyUnits,
    ).toBe('1.75')
    expect(
      map?.querySelector<HTMLElement>('[data-keyboard-key="ShiftLeft"]')?.dataset.keyUnits,
    ).toBe('2.25')

    previous?.focus()
    flushSync()

    expect(map?.dataset.activeSet).toBe('colour-cycle')
    expect(map?.querySelectorAll('[data-active]')).toHaveLength(2)
    expect(map?.querySelector('.caelestis-keymap-callout-detail')?.textContent).toContain(
      'A selects the previous',
    )

    map?.querySelector<HTMLButtonElement>('[data-keyboard-key="Digit3"]')?.focus()
    flushSync()
    expect(map?.dataset.activeSet).toBe('opacity')
    expect(map?.querySelectorAll('[data-active]')).toHaveLength(5)
    expect(map?.querySelector('.caelestis-keymap-callout-detail')?.textContent).toContain(
      '20%, 40%, 60%, 80% or 100%',
    )

    void unmount(component)
  })

  it.each([
    {
      platform: 'mac' as const,
      legends: ['Ctrl', 'Opt', 'Cmd', 'Space'],
      historyKey: 'Cmd+Z',
      activeModifier: 'MetaLeft',
      inactiveModifier: 'ControlLeft',
    },
    {
      platform: 'windows-linux' as const,
      legends: ['Ctrl', 'Win / Meta', 'Alt', 'Space'],
      historyKey: 'Ctrl+Z',
      activeModifier: 'ControlLeft',
      inactiveModifier: 'MetaLeft',
    },
  ])('renders $platform modifiers and history chord', (expected) => {
    const { component } = mountHelp(expected.platform)
    const map = document.querySelector<HTMLElement>('.caelestis-keymap')
    expect(
      Array.from(map?.querySelector('.caelestis-keymap-row:last-child')?.children ?? []).map(
        (key) => key.textContent,
      ),
    ).toEqual(expected.legends)
    expect(map?.dataset.platform).toBe(expected.platform)
    expect(
      [...document.querySelectorAll('.caelestis-shortcut-list kbd')].map((key) => key.textContent),
    ).toContain(expected.historyKey)

    map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyZ"]')?.focus()
    flushSync()
    expect(
      map
        ?.querySelector(`[data-keyboard-key="${expected.activeModifier}"]`)
        ?.hasAttribute('data-active'),
    ).toBe(true)
    expect(
      map
        ?.querySelector(`[data-keyboard-key="${expected.inactiveModifier}"]`)
        ?.hasAttribute('data-active'),
    ).toBe(false)

    void unmount(component)
  })
})
