import { resolveShortcutBindings } from '@caelestis/shared'
import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsPanel from '../src/settings/SettingsPanel.svelte'
import type { SettingsIntent, SettingsModel } from '../src/types.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

const settings = (): SettingsModel => ({
  servers: [],
  colourNavigationOrder: 'unpainted-first',
  reportPaints: true,
  shareTiles: true,
  sharePresence: true,
  showPresence: true,
  showPresenceViewports: true,
  showPresenceClaims: true,
  debugLogging: false,
  performanceProfiling: false,
  notifyRegressions: true,
  notifyGriefing: false,
  notifyUpdates: true,
  notifyActivity: true,
  shortcuts: { platform: 'windows-linux', bindings: resolveShortcutBindings(), customised: true },
  profile: { note: 'No profile recorded.', metrics: [] },
})

describe('settings panel intent boundary', () => {
  it('submits trimmed server input, changes settings, and resets independent user state', () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: { model: settings(), onIntent: (intent) => intents.push(intent) },
      }),
    )

    const server = target.querySelector('input[aria-label="Server address"]') as HTMLInputElement
    server.value = ' https://templates.example.org '
    server.dispatchEvent(new Event('input', { bubbles: true }))
    server.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const order = target.querySelector(
      'select[aria-label="Middle-click colour order"]',
    ) as HTMLSelectElement
    order.value = 'mismatched-first'
    order.dispatchEvent(new Event('change', { bubbles: true }))
    ;(target.querySelector('input[aria-label="Template regressions"]') as HTMLInputElement).click()
    ;(
      target.querySelector(
        'button[title="Reset all shortcuts to their defaults"]',
      ) as HTMLButtonElement
    ).click()
    ;(target.querySelector('.profile-actions button') as HTMLButtonElement).click()

    expect(intents).toEqual([
      { type: 'add-server', url: 'https://templates.example.org' },
      { type: 'set-colour-navigation-order', value: 'mismatched-first' },
      { type: 'set-boolean', key: 'notifyRegressions', value: false },
      { type: 'reset-shortcut-bindings' },
      { type: 'reset-profile' },
    ])
  })
})
