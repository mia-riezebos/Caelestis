// @vitest-environment happy-dom

import { registerCaelestisUi } from '@caelestis/ui/elements'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { toggleShortcutHelp } from './shortcut-help.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => document.body.replaceChildren())

describe('shortcut help adapter', () => {
  it('mounts the shared help element and restores focus when toggled closed', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    toggleShortcutHelp('mac')
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const help = document.querySelector('caelestis-shortcut-help')
    expect(help?.shadowRoot?.querySelector('dialog')?.open).toBe(true)
    expect(help?.shadowRoot?.textContent).toContain('Cmd+Shift+Z')
    expect(help?.style.getPropertyValue('--caelestis-surface')).not.toBe('')

    toggleShortcutHelp('mac')

    expect(document.querySelector('caelestis-shortcut-help')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('removes the host when the shared UI requests close', async () => {
    toggleShortcutHelp('windows-linux')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const dialog = document
      .querySelector('caelestis-shortcut-help')
      ?.shadowRoot?.querySelector<HTMLDialogElement>('dialog')

    dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('caelestis-shortcut-help')).toBeNull()
  })
})
