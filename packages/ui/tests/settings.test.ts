// @vitest-environment happy-dom

import { resolveShortcutBindings } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPanel from '../src/settings/SettingsPanel.svelte'
import type { SettingsModel } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())

const model: SettingsModel = {
  shortcuts: { platform: 'mac', bindings: resolveShortcutBindings(), customised: false },
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
  notifyRegressions: true,
  notifyGriefing: false,
  notifyUpdates: true,
  notifyActivity: false,
}

describe('settings panel', () => {
  it.each([
    ['Template regressions', 'notifyRegressions', true],
    ['Sustained griefing', 'notifyGriefing', false],
    ['Userscript updates', 'notifyUpdates', true],
    ['Action feedback', 'notifyActivity', false],
  ] as const)('renders and toggles %s independently', (label, key, checked) => {
    const onIntent = vi.fn()
    const component = mount(SettingsPanel, { target: document.body, props: { model, onIntent } })
    flushSync()
    const toggle = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
    expect(toggle?.checked).toBe(checked)
    toggle?.click()
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'set-boolean', key, value: !checked })
    void unmount(component)
  })

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

  it('records a replacement chord, cancels on Escape, and clears or resets keys', () => {
    const onIntent = vi.fn()
    const component = mount(SettingsPanel, { target: document.body, props: { model, onIntent } })
    flushSync()
    const control = document.querySelector<HTMLButtonElement>(
      '[data-caelestis-shortcut="toggle-panel"]',
    )
    if (control === null) throw new Error('missing key control')
    expect(control.textContent?.trim()).toBe('C')
    expect(control.getAttribute('aria-label')).toBe('Change key for Caelestis panel, now C')
    expect(control.hasAttribute('data-caelestis-key-capture')).toBe(false)
    expect(
      document.querySelector<HTMLButtonElement>('[title="Reset all shortcuts to their defaults"]')
        ?.disabled,
    ).toBe(true)

    control.click()
    flushSync()
    expect(control.hasAttribute('data-caelestis-key-capture')).toBe(true)
    expect(control.textContent?.trim()).toBe('Press a key…')
    expect(document.querySelector('[role="status"].shortcut-status')?.textContent).toContain(
      'Press the new key',
    )

    const shift = new KeyboardEvent('keydown', {
      key: 'Shift',
      code: 'ShiftLeft',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    })
    control.dispatchEvent(shift)
    expect(onIntent).not.toHaveBeenCalled()
    const chord = new KeyboardEvent('keydown', {
      key: 'P',
      code: 'KeyP',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    })
    control.dispatchEvent(chord)
    flushSync()
    expect(chord.defaultPrevented).toBe(true)
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({
      type: 'set-shortcut-binding',
      id: 'toggle-panel',
      binding: { key: 'p', code: 'KeyP', command: false, shift: true, alt: false },
    })
    expect(control.hasAttribute('data-caelestis-key-capture')).toBe(false)

    control.click()
    flushSync()
    control.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        cancelable: true,
        bubbles: true,
      }),
    )
    flushSync()
    expect(control.hasAttribute('data-caelestis-key-capture')).toBe(false)
    expect(onIntent).toHaveBeenCalledTimes(1)

    document
      .querySelector<HTMLButtonElement>('[aria-label="Remove the key for Caelestis panel"]')
      ?.click()
    expect(onIntent).toHaveBeenLastCalledWith({
      type: 'set-shortcut-binding',
      id: 'toggle-panel',
      binding: null,
    })
    void unmount(component)
  })

  it('shows unassigned keys, both help chords, and enables reset once customised', () => {
    const onIntent = vi.fn()
    const customised: SettingsModel = {
      ...model,
      shortcuts: {
        platform: 'windows-linux',
        bindings: resolveShortcutBindings({
          'toggle-rings': [],
          'toggle-panel': [{ key: 'r', code: 'KeyR', command: false, shift: false, alt: false }],
        }),
        customised: true,
        lastChange: { id: 'toggle-panel', displaced: ['toggle-rings'] },
      },
    }
    const component = mount(SettingsPanel, {
      target: document.body,
      props: { model: customised, onIntent },
    })
    flushSync()

    const rings = document.querySelector<HTMLButtonElement>(
      '[data-caelestis-shortcut="toggle-rings"]',
    )
    expect(rings?.textContent?.trim()).toBe('Not set')
    expect(rings?.getAttribute('aria-label')).toBe(
      'Change key for Toggle contrast rings, now not set',
    )
    expect(
      getComputedStyle(
        document.querySelector('[aria-label="Remove the key for Toggle contrast rings"]')
          ?.parentElement as Element,
      ).visibility,
    ).toBe('hidden')
    const help = document.querySelector('[data-caelestis-shortcut="show-shortcut-help"]')
    expect([...(help?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent)).toEqual([
      '`',
      'Shift+/',
    ])
    expect(help?.querySelector('.shortcut-or')?.textContent).toBe('or')
    expect(
      document.querySelector('[data-caelestis-shortcut="undo-paint"]')?.textContent?.trim(),
    ).toBe('Ctrl+Z')
    expect(document.querySelector('[role="status"].shortcut-status')?.textContent).toBe(
      'R was taken from Toggle contrast rings. Toggle contrast rings now has no key.',
    )

    const reset = document.querySelector<HTMLButtonElement>(
      '[title="Reset all shortcuts to their defaults"]',
    )
    expect(reset?.disabled).toBe(false)
    reset?.click()
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'reset-shortcut-bindings' })
    void unmount(component)
  })

  it('says an action keeps its other chord when only one was taken', () => {
    const [, helpChord] = resolveShortcutBindings()['show-shortcut-help']
    const partial: SettingsModel = {
      ...model,
      shortcuts: {
        platform: 'mac',
        bindings: resolveShortcutBindings({
          'show-shortcut-help': [helpChord as NonNullable<typeof helpChord>],
          'toggle-panel': [
            { key: '`', code: 'Backquote', command: false, shift: false, alt: false },
          ],
        }),
        customised: true,
        lastChange: { id: 'toggle-panel', displaced: ['show-shortcut-help'] },
      },
    }
    const component = mount(SettingsPanel, { target: document.body, props: { model: partial } })
    flushSync()
    expect(document.querySelector('[role="status"].shortcut-status')?.textContent).toBe(
      '` was taken from Keyboard shortcuts. Keyboard shortcuts still has Shift+/.',
    )
    void unmount(component)
  })

  it('keeps the field and section geometry', () => {
    const component = mount(SettingsPanel, { target: document.body, props: { model } })
    flushSync()

    const address = document.querySelector<HTMLElement>('[aria-label="Server address"]')
    const sectionIcon = document.querySelector<HTMLElement>(
      '[data-caelestis-section-icon="server"]',
    )
    const connect = address?.closest<HTMLElement>('.connect')
    expect(getComputedStyle(address as Element).blockSize).toBe('2rem')
    expect(getComputedStyle(sectionIcon as Element).blockSize).toBe('1.75rem')
    expect(getComputedStyle(connect as Element).padding).toBe('0px 16px')
    void unmount(component)
  })

  it('renders token administration and emits operations without owning them', () => {
    const onIntent = vi.fn()
    const adminModel: SettingsModel = {
      ...model,
      servers: [
        {
          ...model.servers[0],
          status: 'connected',
          isAdmin: true,
          accessTokens: {
            status: 'ready',
            tokens: [
              {
                tokenHash: 'hash',
                label: 'Painter',
                scope: 'report',
                createdAt: 1_800_000_000_000,
                bootstrap: false,
              },
            ],
            hasMore: true,
            created: 0,
          },
        },
      ],
    }
    const component = mount(SettingsPanel, {
      target: document.body,
      props: { model: adminModel, onIntent },
    })
    flushSync()

    const label = document.querySelector<HTMLInputElement>('[aria-label="New token label"]')
    if (label === null) throw new Error('missing token label')
    label.value = 'Friend'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    const button = (name: string) =>
      [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)
    button('Create')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'create-access-token',
      url: 'https://templates.example',
      label: 'Friend',
      scope: 'report',
    })

    document.querySelector<HTMLButtonElement>('[aria-label="Delete Painter"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'revoke-access-token',
      url: 'https://templates.example',
      tokenHash: 'hash',
      label: 'Painter',
    })
    button('Load more')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'load-more-access-tokens',
      url: 'https://templates.example',
    })
    void unmount(component)
  })
})
