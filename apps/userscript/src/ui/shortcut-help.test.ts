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

    toggleShortcutHelp()

    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-caelestis-shortcut-help]')
    expect(dialog?.open).toBe(true)
    expect(dialog?.textContent).toContain('Keyboard shortcuts')
    expect(dialog?.textContent).toContain('` or Shift+/')
    expect(dialog?.textContent).toContain('Paint drawer')
    expect(dialog?.textContent).toContain('Cmd/Ctrl+Shift+Z')
    expect(dialog?.textContent).toContain('Redo drafted pixel')
    expect(dialog?.textContent).toContain('Toggle contrast rings')
    expect(dialog?.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(14)
    expect(dialog?.querySelectorAll('.caelestis-shortcut-groups > section')).toHaveLength(2)
    expect(dialog?.querySelector('.caelestis-keymap')).not.toBeNull()
    const box = dialog?.querySelector<HTMLElement>('.caelestis-shortcut-box')
    expect(box?.style.getPropertyValue('max-height')).toBe('var(--caelestis-shortcut-max-height)')
    expect(box?.style.getPropertyPriority('max-height')).toBe('important')

    toggleShortcutHelp()

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
    toggleShortcutHelp()
    const map = document.querySelector<HTMLElement>('.caelestis-keymap')
    const previous = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyA"]')
    const next = map?.querySelector<HTMLButtonElement>('[data-keyboard-key="KeyD"]')
    const unused = map?.querySelector<HTMLElement>('[data-keyboard-key="KeyQ"]')

    expect(previous?.dataset.shortcutSet).toBe('colour-cycle')
    expect(next?.dataset.shortcutSet).toBe('colour-cycle')
    expect(unused).not.toBeInstanceOf(HTMLButtonElement)

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

    toggleShortcutHelp()
  })
})
