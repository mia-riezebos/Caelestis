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

  it('renders token administration and emits operations without owning them', () => {
    const onIntent = vi.fn()
    const adminModel: SettingsModel = {
      ...model,
      servers: [{
        ...model.servers[0],
        status: 'connected',
        isAdmin: true,
        accessTokens: {
          status: 'ready',
          tokens: [{
            tokenHash: 'hash', label: 'Painter', scope: 'report', createdAt: 1_800_000_000_000, bootstrap: false,
          }],
          hasMore: true,
          created: 0,
        },
      }],
    }
    const component = mount(SettingsPanel, { target: document.body, props: { model: adminModel, onIntent } })
    flushSync()

    const label = document.querySelector<HTMLInputElement>('[aria-label="New token label"]')
    if (label === null) throw new Error('missing token label')
    label.value = 'Friend'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    const button = (name: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)
    button('Create')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'create-access-token', url: 'https://templates.example', label: 'Friend', scope: 'report',
    })

    document.querySelector<HTMLButtonElement>('[aria-label="Delete Painter"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'revoke-access-token', url: 'https://templates.example', tokenHash: 'hash', label: 'Painter',
    })
    button('Load more')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'load-more-access-tokens', url: 'https://templates.example' })
    void unmount(component)
  })
})
