// @vitest-environment happy-dom

import { registerCaelestisUi } from '@caelestis/ui/elements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountNotificationsIn, showAmbientToast, syncToastPlacement } from './notification-host.js'
import { PANEL_ID, toast } from './toast.js'

const preferences = vi.hoisted(() => ({ notifyActivity: true }))
vi.mock('../state.js', () => ({ getState: () => preferences }))

beforeEach(() => {
  preferences.notifyActivity = true
  registerCaelestisUi()
  vi.useFakeTimers()
  document.body.replaceChildren()
  const panel = document.createElement('aside')
  panel.id = PANEL_ID
  document.body.appendChild(panel)
})

afterEach(() => {
  mountNotificationsIn(null)
  vi.useRealTimers()
})

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const shadow = (): ShadowRoot | null =>
  document.querySelector('caelestis-notifications')?.shadowRoot ?? null

describe('toast', () => {
  it('mutes action feedback immediately while retaining errors, warnings, and ambient notices', async () => {
    preferences.notifyActivity = false
    toast('Exported')
    await settle()
    expect(shadow()).toBeNull()
    toast('Export failed', 'error')
    toast('Finish placement first', 'warning')
    await settle()
    expect(shadow()?.textContent).toContain('Export failed')
    expect(shadow()?.textContent).toContain('Finish placement first')
    showAmbientToast('Update available')
    await settle()
    expect(shadow()?.textContent).toContain('Update available')
    preferences.notifyActivity = true
    toast('Exported')
    await settle()
    expect(shadow()?.textContent).toContain('Exported')
  })

  it('can announce a page-level warning while the panel is closed', async () => {
    document.getElementById(PANEL_ID)?.remove()
    showAmbientToast('Template regressed', 'warning')
    await settle()

    expect(shadow()?.textContent).toContain('Template regressed')
  })

  it('queues an ambient warning until document-start has a body', async () => {
    document.body.remove()
    showAmbientToast('Early regression', 'warning')
    expect(document.querySelector('caelestis-notifications')).toBeNull()

    document.documentElement.appendChild(document.createElement('body'))
    document.dispatchEvent(new Event('DOMContentLoaded'))
    await settle()

    expect(shadow()?.textContent).toContain('Early regression')
  })

  it('announces messages through one persistent status region', async () => {
    toast('Reading')
    toast('Published')
    await settle()

    const region = shadow()?.querySelector('[role="status"]')
    expect(region?.children).toHaveLength(1)
    expect(region?.textContent).toContain('Published')
  })

  it('passes an action through the userscript notification host', async () => {
    toast('A new version is available.', 'info', {
      label: 'Update userscript',
      href: 'https://example.com/caelestis.user.js',
    })
    await settle()

    const action = shadow()?.querySelector<HTMLAnchorElement>('.toast-action')
    expect(action?.textContent?.trim()).toBe('Update userscript')
    expect(action?.href).toBe('https://example.com/caelestis.user.js')
  })

  it('keeps an action available until the user dismisses it', async () => {
    toast('A new version is available.', 'info', {
      label: 'Update userscript',
      href: 'https://example.com/caelestis.user.js',
    })
    await settle()

    vi.advanceTimersByTime(60_000)
    await settle()

    expect(shadow()?.querySelector('.toast-action')).not.toBeNull()
    shadow()?.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')?.click()
    await settle()
    expect(shadow()?.querySelector('[data-caelestis-toast="info"]')).toBeNull()
  })

  it('keeps errors until they are dismissed', async () => {
    toast('Upload failed', 'error')
    vi.advanceTimersByTime(60_000)
    await settle()

    const error = shadow()?.querySelector<HTMLElement>('[data-caelestis-toast="error"]')
    expect(error?.textContent).toContain('Upload failed')
    error?.querySelector<HTMLButtonElement>('button')?.click()
    await settle()
    expect(shadow()?.querySelector('[data-caelestis-toast="error"]')).toBeNull()
  })

  it('piles errors up behind the newest one and drops the oldest past the cap', async () => {
    for (let index = 1; index <= 8; index++) toast(`Failure ${index}`, 'error')
    await settle()

    const alert = shadow()?.querySelector('[role="alert"]')
    expect(alert?.children).toHaveLength(6)
    expect(alert?.textContent).not.toContain('Failure 2')
    expect(alert?.textContent).toContain('Failure 3')
    expect(shadow()?.querySelector('.toast .message')?.textContent).toBe('Failure 8')
    expect(shadow()?.querySelectorAll('.peek')).toHaveLength(2)

    shadow()?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click()
    await settle()
    expect(shadow()?.querySelector('.toast .message')?.textContent).toBe('Failure 7')
    expect(alert?.children).toHaveLength(5)
  })

  it('replaces stale progress with an error without letting later progress erase it', async () => {
    toast('Preparing…')
    toast('Export failed', 'error')
    await settle()

    expect(shadow()?.querySelector('[data-caelestis-toast="info"]')).toBeNull()
    expect(shadow()?.querySelector('[data-caelestis-toast="error"]')?.textContent).toContain(
      'Export failed',
    )

    // Later progress goes on top of the pile; the error waits behind it, still announced.
    toast('Trying something else…')
    await settle()
    expect(shadow()?.querySelector('[data-caelestis-toast="info"]')?.textContent).toContain(
      'Trying something else…',
    )
    expect(shadow()?.querySelector('[role="alert"]')?.textContent).toContain('Export failed')
    expect(shadow()?.querySelectorAll('.peek')).toHaveLength(1)
  })

  it('stands beside the open panel, and runs along the bottom when there is no room beside it', async () => {
    const panel = document.getElementById(PANEL_ID) as HTMLElement
    Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true })
    panel.getBoundingClientRect = () =>
      ({ left: 1540, width: 400, top: 8, right: 1940, bottom: 992, height: 984 }) as DOMRect
    syncToastPlacement()

    const root = document.querySelector<HTMLElement>('caelestis-notifications')
    expect(root?.style.getPropertyValue('--caelestis-toasts-inset-end')).toBe('472px')
    expect(root?.style.getPropertyValue('--caelestis-toasts-inline-size')).toBe('384px')

    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    panel.getBoundingClientRect = () =>
      ({ left: 70, width: 260, top: 8, right: 330, bottom: 836, height: 828 }) as DOMRect
    syncToastPlacement()
    expect(root?.style.getPropertyValue('--caelestis-toasts-inset-end')).toBe('8px')
    expect(root?.style.getPropertyValue('--caelestis-toasts-inline-size')).toBe('374px')

    panel.remove()
    syncToastPlacement()
    expect(root?.style.getPropertyValue('--caelestis-toasts-inset-end')).toBe('60px')
  })

  it('moves into a popped-out panel dialog and back without losing retained errors', async () => {
    toast('Upload failed', 'error')
    await settle()
    const root = document.querySelector('caelestis-notifications')
    expect(root?.parentNode).toBe(document.body)

    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    mountNotificationsIn(dialog)
    toast('Exported')
    await settle()
    expect(root?.parentNode).toBe(dialog)
    expect(shadow()?.textContent).toContain('Upload failed')
    expect(shadow()?.textContent).toContain('Exported')

    mountNotificationsIn(null)
    dialog.remove()
    await settle()
    expect(root?.parentNode).toBe(document.body)
    expect(shadow()?.querySelector('[role="alert"]')?.textContent).toContain('Upload failed')
    expect(shadow()?.querySelectorAll('.peek')).toHaveLength(1)
  })

  it('removes non-errors after six seconds without removing the custom-element root', async () => {
    toast('Done')
    await settle()
    vi.advanceTimersByTime(6000)
    await settle()

    expect(shadow()?.querySelector('[data-caelestis-toast="info"]')).toBeNull()
    expect(document.querySelector('caelestis-notifications')).not.toBeNull()
  })
})
