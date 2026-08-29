// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { toggleShortcutHelp } from './shortcut-help.js'

beforeEach(() => {
  document.body.replaceChildren()
})

describe('shortcut help', () => {
  it('shows the complete key map in a native dialog and restores focus when toggled closed', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    toggleShortcutHelp('mac')

    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-caelestis-shortcut-help]')
    expect(dialog?.open).toBe(true)
    expect(dialog?.textContent).toContain('Keyboard shortcuts')
    expect(dialog?.textContent).toContain('` or Shift+/')
    expect(dialog?.textContent).toContain('Paint drawer')
    expect(dialog?.textContent).toContain('Cmd+Shift+Z')
    expect(dialog?.textContent).toContain('Redo drafted pixel')
    expect(dialog?.textContent).toContain('Toggle contrast rings')
    expect(dialog?.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(14)
    expect(dialog?.querySelectorAll('.caelestis-shortcut-groups > section')).toHaveLength(2)
    expect(dialog?.querySelector('.caelestis-keymap')).not.toBeNull()
    const layout = dialog?.querySelector('.caelestis-shortcut-layout')
    expect(layout?.children[0]?.classList.contains('caelestis-shortcut-groups')).toBe(true)
    expect(layout?.children[1]?.classList.contains('caelestis-keymap')).toBe(true)
    const box = dialog?.querySelector<HTMLElement>('.caelestis-shortcut-box')
    expect(box?.style.getPropertyValue('max-height')).toBe('var(--caelestis-shortcut-max-height)')
    expect(box?.style.getPropertyPriority('max-height')).toBe('important')

    toggleShortcutHelp('mac')

    expect(document.querySelector('dialog[data-caelestis-shortcut-help]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on a backdrop click', () => {
    toggleShortcutHelp()
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-caelestis-shortcut-help]')

    dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('dialog[data-caelestis-shortcut-help]')).toBeNull()
  })

  it('groups related keys and reveals their shared explanation on focus', () => {
    toggleShortcutHelp('mac')
    const map = document.querySelector<HTMLElement>('.caelestis-keymap')
    const previous = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyA"]')
    const next = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyD"]')
    const unused = map?.querySelector<HTMLElement>('[data-keyboard-key="KeyQ"]')

    expect(previous?.dataset.shortcutSet).toBe('colour-cycle')
    expect(next?.dataset.shortcutSet).toBe('colour-cycle')
    expect(unused).not.toBeInstanceOf(HTMLButtonElement)
    const oneUnitKeys = ['Digit1', 'KeyQ', 'KeyA', 'KeyZ'].map((code) =>
      map?.querySelector<HTMLElement>(`[data-keyboard-key="${code}"]`),
    )
    expect(oneUnitKeys.map((key) => key?.dataset.keyUnits)).toEqual(['1', '1', '1', '1'])
    expect(oneUnitKeys.map((key) => key?.style.getPropertyValue('--caelestis-key-basis'))).toEqual([
      '4em',
      '4em',
      '4em',
      '4em',
    ])
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

    expect(map?.dataset.activeSet).toBe('colour-cycle')
    expect(map?.querySelectorAll('[data-active]')).toHaveLength(2)
    expect(map?.querySelector('.caelestis-keymap-callout-detail')?.textContent).toContain(
      'Cycle unfinished colours',
    )
    expect(map?.querySelector('.caelestis-keymap-callout-detail')?.textContent).toContain(
      'A selects the previous',
    )

    const opacity = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="Digit3"]')
    opacity?.focus()

    expect(map?.dataset.activeSet).toBe('opacity')
    expect(map?.querySelectorAll('[data-active]')).toHaveLength(5)
    expect(map?.querySelector('.caelestis-keymap-callout-detail')?.textContent).toContain(
      '20%, 40%, 60%, 80% or 100%',
    )

    toggleShortcutHelp('mac')
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
    toggleShortcutHelp(expected.platform)
    const map = document.querySelector<HTMLElement>('.caelestis-keymap')
    const modifierRow = map?.querySelector('.caelestis-keymap-row:last-child')
    expect(Array.from(modifierRow?.children ?? []).map((key) => key.textContent)).toEqual(
      expected.legends,
    )
    expect(map?.dataset.platform).toBe(expected.platform)
    expect(
      [...document.querySelectorAll('.caelestis-shortcut-list kbd')].map((key) => key.textContent),
    ).toContain(expected.historyKey)

    map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyZ"]')?.focus()

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

    toggleShortcutHelp(expected.platform)
  })
})
