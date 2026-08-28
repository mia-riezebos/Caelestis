// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPanel from '../src/settings/SettingsPanel.svelte'
import type { SettingsModel } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())

const model: SettingsModel = {
  servers: [
    {
      url: 'https://templates.example',
      name: 'Example',
      status: 'needs-token',
      expanded: true,
      tokenSaved: false,
      isAdmin: false,
    },
  ],
  colourNavigationOrder: 'unpainted-first',
  reportPaints: true,
  shareTiles: false,
  debugLogging: false,
  performanceProfiling: false,
}

describe('settings panel', () => {
  it('keeps drafts local and emits typed server and preference intents', () => {
    const onIntent = vi.fn()
    const component = mount(SettingsPanel, { target: document.body, props: { model, onIntent } })
    flushSync()

    const address = document.querySelector<HTMLInputElement>('[aria-label="Server address"]')
    if (address === null) throw new Error('missing server address')
    address.value = 'https://new.example'
    address.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'add-server', url: 'https://new.example' })

    document.querySelector<HTMLInputElement>('[aria-label="Share tiles"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-boolean', key: 'shareTiles', value: true })
    void unmount(component)
  })
})
