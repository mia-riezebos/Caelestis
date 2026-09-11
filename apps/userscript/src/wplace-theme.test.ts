// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  setStyle: vi.fn(),
  resources: [] as string[],
}))

vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./map-handle.js', () => ({ getMap: () => ({ setStyle: harness.setStyle }) }))

/** A stand-in for Wplace's setter: storage, attribute, and a pressed-state group in a dialog. */
const installWplace = (initial = 'custom-winter', { settings = true } = {}): void => {
  localStorage.setItem('theme', initial)
  document.documentElement.setAttribute('data-theme', initial)
  const setTheme = (theme: string): void => {
    localStorage.setItem('theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-option]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme))
    }
  }
  if (!settings) return
  const opener = document.createElement('button')
  opener.setAttribute('aria-label', 'Settings')
  opener.addEventListener('click', () => {
    // Svelte renders after the click, on a microtask; do the same.
    queueMicrotask(() => {
      const dialog = document.createElement('dialog')
      dialog.className = 'modal'
      dialog.innerHTML = `
        <div role="group" aria-label="Theme">
          <button type="button" data-theme-option="custom-winter" aria-pressed="true"><svg></svg> Light mode</button>
          <button type="button" data-theme-option="dark" aria-pressed="false"><svg></svg> Dark mode</button>
        </div>`
      for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-theme-option]')) {
        button.addEventListener('click', () => setTheme(button.dataset.themeOption ?? ''))
      }
      dialog.close = () => {
        dialog.removeAttribute('open')
        dialog.remove()
      }
      dialog.setAttribute('open', '')
      document.body.appendChild(dialog)
    })
  })
  document.body.appendChild(opener)
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  localStorage.clear()
  harness.setStyle.mockClear()
  harness.resources = ['https://maps.wplace.live/styles/liberty']
  vi.stubGlobal('performance', {
    ...performance,
    now: () => Date.now(),
    getEntriesByType: () => harness.resources.map((name) => ({ name })),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('toggleWplaceTheme', () => {
  it('clicks a visible native control and keeps every copy of the state together', async () => {
    installWplace('custom-winter')
    document.querySelector<HTMLElement>('[aria-label="Settings"]')?.click()
    await Promise.resolve()
    const { toggleWplaceTheme } = await import('./wplace-theme.js')

    expect(toggleWplaceTheme()).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(harness.setStyle).not.toHaveBeenCalled()
  })

  it('goes through a hidden settings dialog when no control is on screen', async () => {
    installWplace('custom-winter')
    const { toggleWplaceTheme } = await import('./wplace-theme.js')

    expect(toggleWplaceTheme()).toBe(true)
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
    expect(document.querySelector('dialog[open]')).toBeNull()
    expect(document.getElementById('caelestis-theme-sync')).toBeNull()
    expect(harness.setStyle).not.toHaveBeenCalled()

    expect(toggleWplaceTheme()).toBe(true)
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('custom-winter'),
    )
  })

  it('falls back to setting the theme and swapping the map style itself', async () => {
    installWplace('custom-winter', { settings: false })
    const { toggleWplaceTheme } = await import('./wplace-theme.js')

    expect(toggleWplaceTheme()).toBe(true)
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(harness.setStyle).toHaveBeenCalledWith('https://maps.wplace.live/styles/fiord')

    harness.resources = ['https://maps.wplace.live/styles/fiord']
    expect(toggleWplaceTheme()).toBe(true)
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('custom-winter'),
    )
    expect(harness.setStyle).toHaveBeenLastCalledWith('https://maps.wplace.live/styles/liberty')
  })

  it('remembers a renamed light theme instead of assuming the default', async () => {
    installWplace('custom-summer', { settings: false })
    const { toggleWplaceTheme, currentWplaceTheme } = await import('./wplace-theme.js')
    expect(currentWplaceTheme()).toBe('custom-summer')
    toggleWplaceTheme()
    await vi.waitFor(() => expect(currentWplaceTheme()).toBe('dark'))
    toggleWplaceTheme()
    await vi.waitFor(() => expect(currentWplaceTheme()).toBe('custom-summer'))
  })

  it('leaves an already open dialog alone and applies directly instead', async () => {
    installWplace('custom-winter')
    const other = document.createElement('dialog')
    other.setAttribute('open', '')
    document.body.appendChild(other)
    const { toggleWplaceTheme } = await import('./wplace-theme.js')

    toggleWplaceTheme()
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
    expect(harness.setStyle).toHaveBeenCalledOnce()
  })
})
