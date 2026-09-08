// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisNotifications, registerCaelestisUi } from '../src/elements/index.js'
import type { NotificationsModel } from '../src/index.js'

beforeAll(() => registerCaelestisUi())

beforeEach(() => document.body.replaceChildren())

const model = (overrides: Partial<NotificationsModel> = {}): NotificationsModel => ({
  toasts: [],
  confirm: null,
  ...overrides,
})

describe('notifications', () => {
  it('keeps both live regions mounted while empty so later toasts are announced', async () => {
    const root = new CaelestisNotifications()
    document.body.append(root)
    await tick()

    const status = root.shadowRoot?.querySelector('[role="status"]')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.children).toHaveLength(0)
    expect(root.shadowRoot?.querySelector('[role="alert"]')?.children).toHaveLength(0)
  })

  it('announces errors as alerts, notices as status, and emits a composed dismiss intent', async () => {
    const root = new CaelestisNotifications()
    const intent = vi.fn()
    root.addEventListener('caelestis-notifications-intent', intent)
    root.model = model({
      toasts: [
        { id: 'toast-1', kind: 'error', message: 'Upload failed' },
        { id: 'toast-2', kind: 'info', message: 'Exported “City”.' },
      ],
    })
    document.body.append(root)
    await tick()

    const alert = root.shadowRoot?.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Upload failed')
    expect(alert?.textContent).not.toContain('Exported')
    const status = root.shadowRoot?.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Exported “City”.')

    // The newest toast is on top of the pile, so its dismiss button is the one shown.
    expect(root.shadowRoot?.querySelector('[aria-label="Dismiss error"]')).toBeNull()
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')
      ?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { type: 'dismiss-toast', id: 'toast-2' },
        bubbles: true,
        composed: true,
      }),
    )
  })

  it('piles several toasts behind the newest and expands into a list on request', async () => {
    const root = new CaelestisNotifications()
    const intent = vi.fn()
    root.addEventListener('caelestis-notifications-intent', intent)
    root.model = model({
      toasts: [
        { id: 'toast-1', kind: 'error', message: 'Upload failed' },
        { id: 'toast-2', kind: 'error', message: 'Delete failed' },
        { id: 'toast-3', kind: 'info', message: 'Exported “City”.' },
      ],
    })
    document.body.append(root)
    await tick()

    const shadow = root.shadowRoot
    expect(shadow?.querySelectorAll('.toast')).toHaveLength(1)
    expect(shadow?.querySelector('.toast')?.textContent).toContain('Exported “City”.')
    expect(shadow?.querySelectorAll('.peek')).toHaveLength(2)

    const more = [...(shadow?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '+2 more',
    )
    more?.click()
    await tick()
    const listed = [...(shadow?.querySelectorAll('.toast') ?? [])].map(
      (item) => item.querySelector('.message')?.textContent,
    )
    expect(listed).toEqual(['Exported “City”.', 'Delete failed', 'Upload failed'])
    expect(shadow?.querySelectorAll('.peek')).toHaveLength(0)

    const showLess = [...(shadow?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Show less',
    )
    showLess?.click()
    await tick()
    expect(shadow?.querySelectorAll('.toast')).toHaveLength(1)

    // Dismissing the top card removes only it; the host then promotes the next one.
    shadow?.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')?.click()
    expect(intent).toHaveBeenCalledTimes(1)
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'dismiss-toast', id: 'toast-3' } }),
    )
    root.model = model({
      toasts: [
        { id: 'toast-1', kind: 'error', message: 'Upload failed' },
        { id: 'toast-2', kind: 'error', message: 'Delete failed' },
      ],
    })
    await tick()
    expect(shadow?.querySelector('.toast')?.textContent).toContain('Delete failed')
    expect(shadow?.querySelectorAll('.peek')).toHaveLength(1)
  })

  it('renders a toast action as an external link', async () => {
    const root = new CaelestisNotifications()
    root.model = model({
      toasts: [
        {
          id: 'toast-1',
          kind: 'info',
          message: 'Caelestis v0.7.0 is available.',
          action: {
            label: 'Update userscript',
            href: 'https://github.com/mia-riezebos/Caelestis/releases/latest/download/caelestis.user.js',
          },
        },
      ],
    })
    document.body.append(root)
    await tick()

    const action = root.shadowRoot?.querySelector<HTMLAnchorElement>('.toast-action')
    expect(action?.textContent?.trim()).toBe('Update userscript')
    expect(action?.href).toBe(
      'https://github.com/mia-riezebos/Caelestis/releases/latest/download/caelestis.user.js',
    )
    expect(action?.target).toBe('_blank')
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
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="Access token"]')?.value).toBe(
      'only-copy',
    )
    const button = (name: string) =>
      [...(dialog?.querySelectorAll('button') ?? [])].find(
        (item) => item.textContent?.trim() === name,
      )
    button('Copy')?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'copy-one-time-secret', id: 'secret-1' } }),
    )
    button('I have copied it')?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'resolve-one-time-secret', id: 'secret-1' } }),
    )
  })
})
