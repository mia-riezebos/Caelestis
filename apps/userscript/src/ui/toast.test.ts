// @vitest-environment happy-dom

import { registerCaelestisUi } from '@caelestis/ui/elements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showAmbientToast } from './notification-host.js'
import { PANEL_ID, toast } from './toast.js'

beforeEach(() => {
  registerCaelestisUi()
  vi.useFakeTimers()
  document.body.replaceChildren()
  const panel = document.createElement('aside')
  panel.id = PANEL_ID
  document.body.appendChild(panel)
})

afterEach(() => vi.useRealTimers())

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const shadow = (): ShadowRoot | null =>
  document.querySelector('caelestis-notifications')?.shadowRoot ?? null

describe('toast', () => {
  it('can announce a page-level warning while the panel is closed', async () => {
    document.getElementById(PANEL_ID)?.remove()
    showAmbientToast('Template regressed', 'warning')
    await settle()

    expect(shadow()?.textContent).toContain('Template regressed')
  })

  it('announces messages through one persistent status region', async () => {
    toast('Reading')
    toast('Published')
    await settle()

    const region = shadow()?.querySelector('[role="status"]')
    expect(region?.children).toHaveLength(1)
    expect(region?.textContent).toContain('Published')
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

  it('replaces stale progress with an error without letting later progress erase it', async () => {
    toast('Preparing…')
    toast('Export failed', 'error')
    await settle()

    expect(shadow()?.querySelector('[data-caelestis-toast="info"]')).toBeNull()
    expect(shadow()?.querySelector('[data-caelestis-toast="error"]')?.textContent).toContain(
      'Export failed',
    )

    toast('Trying something else…')
    await settle()
    expect(shadow()?.querySelector('[data-caelestis-toast="error"]')?.textContent).toContain(
      'Export failed',
    )
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
