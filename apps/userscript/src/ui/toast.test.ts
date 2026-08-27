// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_ID, toast } from './toast.js'

beforeEach(() => {
  vi.useFakeTimers()
  document.body.replaceChildren()
  const panel = document.createElement('aside')
  panel.id = PANEL_ID
  document.body.appendChild(panel)
})

describe('toast', () => {
  it('announces messages through one persistent status region', () => {
    toast('Reading')
    toast('Published')

    const region = document.querySelector('[role="status"]')
    expect(region?.children).toHaveLength(1)
    expect(region?.textContent).toContain('Published')
  })

  it('keeps errors until they are dismissed', () => {
    toast('Upload failed', 'error')
    vi.advanceTimersByTime(60_000)

    const error = document.querySelector<HTMLElement>('[data-caelestis-toast="error"]')
    expect(error?.textContent).toContain('Upload failed')
    error?.querySelector<HTMLButtonElement>('button')?.click()
    expect(document.querySelector('[data-caelestis-toast="error"]')).toBeNull()
  })

  it('replaces stale progress with an error without letting later progress erase it', () => {
    toast('Preparing…')
    toast('Export failed', 'error')

    expect(document.querySelector('[data-caelestis-toast="info"]')).toBeNull()
    expect(document.querySelector('[data-caelestis-toast="error"]')?.textContent).toContain(
      'Export failed',
    )

    toast('Trying something else…')
    expect(document.querySelector('[data-caelestis-toast="error"]')?.textContent).toContain(
      'Export failed',
    )
  })

  it('removes non-errors after six seconds without removing the live region', () => {
    toast('Done')
    vi.advanceTimersByTime(6000)

    expect(document.querySelector('[data-caelestis-toast="info"]')).toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })
})
