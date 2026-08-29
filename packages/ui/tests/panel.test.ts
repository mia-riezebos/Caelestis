// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisPanel, registerCaelestisUi } from '../src/elements/index.js'
import type { PanelModel } from '../src/index.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => document.body.replaceChildren())

const model = (overrides: Partial<PanelModel> = {}): PanelModel => ({
  view: 'tree',
  width: 360,
  minWidth: 260,
  maxWidth: 720,
  ...overrides,
})

describe('panel shell', () => {
  it('renders the active view around slotted host content', async () => {
    const panel = new CaelestisPanel()
    panel.model = model({ view: 'settings' })
    const content = document.createElement('section')
    content.textContent = 'Host settings'
    panel.append(content)
    document.body.append(panel)
    await tick()

    expect(panel.shadowRoot?.querySelector('h2')?.textContent).toBe('Settings')
    expect(panel.shadowRoot?.querySelector('slot')).not.toBeNull()
    expect(panel.textContent).toContain('Host settings')
    expect(panel.style.width).toBe('360px')
  })

  it('emits one composed intent event for navigation and closing', async () => {
    const panel = new CaelestisPanel()
    const intent = vi.fn()
    panel.model = model()
    panel.addEventListener('caelestis-panel-intent', intent)
    document.body.append(panel)
    await tick()

    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click()
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()

    expect(intent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ detail: { type: 'navigate', view: 'settings' }, composed: true }),
    )
    expect(intent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ detail: { type: 'close' }, composed: true }),
    )
  })

  it('previews keyboard resizing and commits once the key is released', async () => {
    const panel = new CaelestisPanel()
    const intent = vi.fn()
    panel.model = model()
    panel.addEventListener('caelestis-panel-intent', intent)
    document.body.append(panel)
    await tick()

    const separator = panel.shadowRoot?.querySelector<HTMLElement>('[role="separator"]')
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    separator?.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))

    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'resize-preview', width: 376 } }),
    )
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'resize-commit', width: 376 } }),
    )
  })
})
