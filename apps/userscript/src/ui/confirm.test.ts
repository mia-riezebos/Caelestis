// @vitest-environment happy-dom

import { registerCaelestisUi } from '@caelestis/ui/elements'
import { beforeEach, describe, expect, it } from 'vitest'
import { confirmDestructive } from './confirm.js'
import { showOneTimeSecret } from './notification-host.js'

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  registerCaelestisUi()
  document.body.replaceChildren()
})

describe('confirmDestructive', () => {
  it('resolves from the Svelte dialog and restores focus', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)

    const answer = confirmDestructive({
      title: 'Delete template?',
      body: 'City will be permanently removed.',
      confirmLabel: 'Delete',
      restoreFocusTo: trigger,
    })
    await settle()

    const root = document.querySelector('caelestis-notifications')
    const dialog = root?.shadowRoot?.querySelector('dialog')
    expect(dialog?.textContent).toContain('Delete template?')
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Delete',
    )
    confirm?.click()

    await expect(answer).resolves.toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('resolves the one-time secret only through its explicit acknowledgement', async () => {
    const shown = showOneTimeSecret('Painter', 'only-copy')
    await settle()
    const root = document.querySelector('caelestis-notifications')
    const dialog = root?.shadowRoot?.querySelector('dialog')
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="Access token"]')?.value).toBe('only-copy')
    const done = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'I have copied it',
    )
    done?.click()
    await expect(shown).resolves.toBeUndefined()
  })
})
