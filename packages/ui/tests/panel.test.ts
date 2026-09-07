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
  it('limits grid browsing to the modal and restores the sidebar on dismissal', async () => {
    const panel = new CaelestisPanel()
    panel.model = model({ tree: { ...tree, displayMode: 'grid' } })
    document.body.append(panel)
    await tick()
    const root = panel.shadowRoot
    if (root === null) throw new Error('missing panel root')
    const click = (label: string) =>
      root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click()
    expect(root.querySelector('.preview-grid')).toBeNull()
    expect(root.querySelector('[aria-label="Template display"]')).toBeNull()
    expect(root.querySelector('[aria-label="Pop out menu"]')?.getAttribute('aria-haspopup')).toBe(
      'dialog',
    )
    for (const dismiss of ['cancel', 'Return to sidebar', 'Close']) {
      click('Pop out menu')
      await tick()
      const dialog = root.querySelector('dialog')
      expect(dialog?.open).toBe(true)
      expect(dialog?.querySelector('.preview-grid')).not.toBeNull()
      expect(dialog?.querySelector('[aria-label="Template display"]')).not.toBeNull()
      expect(dialog?.querySelector('[role="separator"]')).toBeNull()
      if (dismiss === 'cancel') dialog?.dispatchEvent(new Event('cancel', { cancelable: true }))
      else click(dismiss)
      await tick()
      await tick()
      expect(root.querySelector('dialog')).toBeNull()
      expect(root.querySelector('.preview-grid')).toBeNull()
      expect(root.activeElement?.getAttribute('aria-label')).toBe('Pop out menu')
    }
  })

  it('moves keyboard focus into card actions and returns it when dismissed', async () => {
    const panel = new CaelestisPanel()
    const row = {
      type: 'row',
      key: 'art',
      name: 'Artwork',
      icon: 'image',
      depth: 0,
      parentKey: null,
      container: false,
      expanded: false,
      visible: true,
      setSize: 1,
      positionInSet: 1,
      contextMenu: true,
    } as const
    const initial = {
      ...tree,
      entries: [row, { ...row, key: 'other', name: 'Other artwork' }],
      displayMode: 'grid',
    } as const
    panel.model = model({ tree: initial })
    document.body.append(panel)
    await tick()
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Pop out menu"]')?.click()
    await tick()
    const root = panel.shadowRoot
    const trigger = root?.querySelector<HTMLButtonElement>('[aria-label="Actions for Artwork"]')
    if (root === null || root === undefined || trigger === null || trigger === undefined)
      throw new Error('missing menu trigger')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    panel.model = model({
      tree: {
        ...initial,
        contextMenu: {
          id: 'actions',
          rowKey: 'art',
          x: 0,
          y: 0,
          items: [
            { id: 'rename', label: 'Rename', icon: 'rename' },
            { id: 'move', label: 'Move', icon: 'move' },
          ],
        },
      },
    })
    await tick()
    await tick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(
      root.querySelector('[aria-label="Actions for Other artwork"]')?.getAttribute('aria-expanded'),
    ).toBe('false')
    expect(root.activeElement?.textContent).toContain('Rename')
    root.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
    expect(root.activeElement?.textContent).toContain('Move')
    const escapeKey = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    root.activeElement?.dispatchEvent(escapeKey)
    expect(escapeKey.defaultPrevented).toBe(true)
    expect(root.querySelector('dialog')?.open).toBe(true)
    panel.model = model({ tree: initial })
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(root.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
  it('switches display modes without replacing rows or losing focus and progress disclosure', async () => {
    const panel = new CaelestisPanel()
    const entries: TemplateTreeModel['entries'] = [
      {
        type: 'row',
        key: 'art',
        name: 'Artwork',
        icon: 'image',
        depth: 0,
        parentKey: null,
        container: false,
        expanded: false,
        visible: true,
        setSize: 1,
        positionInSet: 1,
        progress: { completed: 1, mismatched: 1, unpainted: 2, known: 4, total: 4 },
      },
    ]
    const initial = { ...tree, entries, focusedKey: 'art' }
    panel.model = model({ tree: initial })
    document.body.append(panel)
    await tick()
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Pop out menu"]')?.click()
    await tick()
    const root = panel.shadowRoot
    const row = root?.querySelector<HTMLElement>('[data-caelestis-tree-key="art"]')
    if (root === null || root === undefined || row === null || row === undefined)
      throw new Error('missing row')
    root.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')?.click()
    await tick()
    const emitted = vi.fn()
    panel.addEventListener('caelestis-panel-intent', emitted)
    for (const displayMode of ['grid', 'tree'] as const) {
      root
        .querySelector<HTMLButtonElement>(
          `[aria-label="${displayMode === 'grid' ? 'Preview grid view' : 'Tree view'}"]`,
        )
        ?.click()
      expect(emitted).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detail: { type: 'tree', intent: { type: 'display-mode', mode: displayMode } },
        }),
      )
      panel.model = model({ tree: { ...initial, displayMode } })
      await tick()
      expect(root.querySelector('[data-caelestis-tree-key="art"]')).toBe(row)
      expect(row.getAttribute('aria-current')).toBe('true')
      expect(row.querySelector('[aria-label="Collapse progress"]') !== null).toBe(
        displayMode === 'tree',
      )
      expect(row.classList.contains('preview-card')).toBe(displayMode === 'grid')
    }
  })
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
          rowKey: 'local',
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

  it('marks only the current template as focus moves and clears', async () => {
    const panel = new CaelestisPanel()
    const entries: TemplateTreeModel['entries'] = [
      ...tree.entries,
      {
        type: 'row',
        key: 'local:city',
        name: 'City',
        icon: 'image',
        depth: 1,
        parentKey: 'local',
        container: false,
        expanded: false,
        visible: true,
        setSize: 1,
        positionInSet: 1,
      },
      {
        type: 'row',
        key: 'local:forest',
        name: 'Forest',
        icon: 'image',
        depth: 1,
        parentKey: 'local',
        container: false,
        expanded: false,
        visible: true,
        setSize: 1,
        positionInSet: 1,
      },
    ]
    const focusedRows = (): HTMLElement[] =>
      Array.from(panel.shadowRoot?.querySelectorAll<HTMLElement>('[aria-current="true"]') ?? [])

    panel.model = model({ tree: { ...tree, entries, focusedKey: 'local:city' } })
    document.body.append(panel)
    await tick()
    expect(focusedRows().map((row) => row.dataset.caelestisTreeKey)).toEqual(['local:city'])
    expect(focusedRows()[0]?.classList).toContain('focused-template')

    panel.model = model({ tree: { ...tree, entries, focusedKey: 'local:forest' } })
    await tick()
    expect(focusedRows().map((row) => row.dataset.caelestisTreeKey)).toEqual(['local:forest'])

    panel.model = model({ tree: { ...tree, entries } })
    await tick()
    expect(focusedRows()).toHaveLength(0)
  })
})
