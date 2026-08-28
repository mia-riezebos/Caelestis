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
})
