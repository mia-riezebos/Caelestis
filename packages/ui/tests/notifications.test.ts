// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationsModel } from '../src/index.js'
import {
  CaelestisNotifications,
  registerCaelestisUi,
} from '../src/elements/index.js'

beforeAll(() => registerCaelestisUi())

beforeEach(() => document.body.replaceChildren())

const model = (overrides: Partial<NotificationsModel> = {}): NotificationsModel => ({
  toasts: [],
  confirm: null,
  ...overrides,
})

describe('notifications', () => {
  it('renders an atomic live region and emits a composed dismiss intent', async () => {
    const root = new CaelestisNotifications()
    const intent = vi.fn()
    root.addEventListener('caelestis-notifications-intent', intent)
    root.model = model({
      toasts: [{ id: 'toast-1', kind: 'error', message: 'Upload failed' }],
    })
    document.body.append(root)
    await tick()

    const region = root.shadowRoot?.querySelector('[role="status"]')
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.getAttribute('aria-atomic')).toBe('true')
    expect(region?.textContent).toContain('Upload failed')

    root.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { type: 'dismiss-toast', id: 'toast-1' },
        bubbles: true,
        composed: true,
      }),
    )
  })

  it('renders a destructive confirmation and emits one answer intent', async () => {
    const root = new CaelestisNotifications()
    const intent = vi.fn()
    root.addEventListener('caelestis-notifications-intent', intent)
    root.model = model({
      confirm: {
        id: 'confirm-1',
        title: 'Delete template?',
        body: 'City will be permanently removed.',
        note: 'This action cannot be undone.',
        confirmLabel: 'Delete',
      },
    })
    document.body.append(root)
    await tick()

    const dialog = root.shadowRoot?.querySelector('dialog')
    expect(dialog?.textContent).toContain('Delete template?')
    expect(dialog?.textContent).toContain('City will be permanently removed.')

    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Delete',
    )
    confirm?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { type: 'resolve-confirm', id: 'confirm-1', value: true },
      }),
    )
  })

  it('keeps a one-time secret modal explicit and emits copy and acknowledgement intents', async () => {
    const root = new CaelestisNotifications()
    const intent = vi.fn()
    root.addEventListener('caelestis-notifications-intent', intent)
    root.model = model({
      oneTimeSecret: { id: 'secret-1', label: 'Painter', value: 'only-copy' },
    })
    document.body.append(root)
    await tick()

    const dialog = root.shadowRoot?.querySelector('dialog')
    expect(dialog?.textContent).toContain('It is shown once.')
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="Access token"]')?.value).toBe('only-copy')
    const button = (name: string) => [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === name)
    button('Copy')?.click()
    expect(intent).toHaveBeenCalledWith(expect.objectContaining({ detail: { type: 'copy-one-time-secret', id: 'secret-1' } }))
    button('I have copied it')?.click()
    expect(intent).toHaveBeenCalledWith(expect.objectContaining({ detail: { type: 'resolve-one-time-secret', id: 'secret-1' } }))
  })
})
