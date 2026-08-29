// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisPanel, registerCaelestisUi } from '../src/elements/index.js'
import type { AppearanceEditorModel, PanelModel, TemplateTreeModel } from '../src/index.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => document.body.replaceChildren())

const model = (overrides: Partial<PanelModel> = {}): PanelModel => ({
  view: 'tree',
  width: 360,
  minWidth: 260,
  maxWidth: 720,
  ...overrides,
})

const appearance: AppearanceEditorModel = {
  values: {
    size: 1,
    radius: 0,
    translateX: 0,
    translateY: 0,
    rotation: 0,
    opacity: 1,
    contrastOutline: true,
    contrastOutlineSize: 1,
    markMismatch: false,
    markUnpainted: false,
    unpaintedLimit: 0.05,
    markerColour: '#ff00ff',
    markerSize: 9,
    markSelectedColour: false,
    selectedMarkerColour: '#ffffff',
    selectedMarkerSize: 9,
    dimOthers: false,
    otherOpacity: 0.15,
    otherColour: null,
  },
  sliders: [
    {
      key: 'opacity',
      label: 'Opacity',
      value: 1,
      defaultValue: 1,
      min: 0,
      max: 1,
      step: 0.05,
      format: 'percent',
    },
  ],
  pixelPresets: [{ id: 'full', label: 'Full pixel', active: true }],
  colourPresets: [],
  palette: [],
  onlySelectedColour: false,
  paintOpen: false,
}

const tree: TemplateTreeModel = {
  query: '',
  sort: { field: 'custom', direction: 'asc' },
  entries: [
    {
      type: 'row',
      key: 'local',
      name: 'Local',
      icon: 'folder',
      depth: 0,
      parentKey: null,
      container: true,
      expanded: false,
      visible: true,
      contextMenu: true,
      setSize: 1,
      positionInSet: 1,
    },
  ],
}

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

  it('matches Wplace panel and header-control geometry', async () => {
    const panel = new CaelestisPanel()
    panel.model = model({ view: 'appearance', appearance })
    document.body.append(panel)
    await tick()

    const surface = panel.shadowRoot?.querySelector<HTMLElement>('.panel')
    const header = panel.shadowRoot?.querySelector<HTMLElement>('header')
    const settings = panel.shadowRoot?.querySelector<HTMLElement>('[aria-label="Settings"]')
    const appearanceButton = panel.shadowRoot?.querySelector<HTMLElement>(
      '[aria-label="Appearance"]',
    )
    const preset = panel.shadowRoot?.querySelector<HTMLElement>('[aria-label="Full pixel"]')
    const toggle = panel.shadowRoot?.querySelector<HTMLElement>('[aria-label="Contrast outline"]')
    const range = panel.shadowRoot?.querySelector<HTMLElement>('[aria-label="Opacity"]')
    expect(getComputedStyle(surface as Element).borderRadius).toBe('12px')
    expect(getComputedStyle(header as Element).padding).toBe('16px 24px')
    expect(getComputedStyle(settings as Element).blockSize).toBe('1.5rem')
    expect(getComputedStyle(settings as Element).borderRadius).toBe('999px')
    expect(getComputedStyle(preset as Element).blockSize).toBe('2rem')
    expect(getComputedStyle(preset as Element).borderRadius).toBe('999px')
    expect(getComputedStyle(toggle as Element).blockSize).toBe('1.25rem')
    expect(getComputedStyle(range as Element).appearance).toBe('none')
    expect(getComputedStyle(range as Element).blockSize).toBe('1rem')
    expect(appearanceButton?.querySelector('path')?.getAttribute('d')).toContain('Zm-220-440')
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

  it('restores a tree row after its shadow-DOM context menu closes', async () => {
    const panel = new CaelestisPanel()
    panel.model = model({ tree })
    document.body.append(panel)
    await tick()

    const row = panel.shadowRoot?.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    row?.focus()
    panel.model = model({
      tree: {
        ...tree,
        contextMenu: {
          id: 'menu-1',
          x: 20,
          y: 30,
          items: [{ id: 'delete', label: 'Delete', icon: 'trash' }],
        },
      },
    })
    await tick()
    panel.shadowRoot?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()

    panel.model = model({ tree })
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(panel.shadowRoot?.activeElement).toBe(row)
  })
})
