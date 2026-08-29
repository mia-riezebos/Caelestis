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
    expect(dialog?.textContent).toContain('Shift+/')
    expect(dialog?.textContent).toContain('Paint drawer')
    expect(dialog?.textContent).toContain('Cmd/Ctrl+Shift+Z')
    expect(dialog?.textContent).toContain('Redo drafted pixel')
    expect(dialog?.textContent).toContain('Toggle contrast rings')
    expect(dialog?.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(14)

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
})
