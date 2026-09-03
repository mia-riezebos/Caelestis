// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TemplateTree from '../src/tree/TemplateTree.svelte'
import type { TemplateTreeModel } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())
afterEach(() => vi.useRealTimers())

const model: TemplateTreeModel = {
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
      draggable: true,
      setSize: 1,
      positionInSet: 1,
      actions: [{ id: 'import', label: 'Import template', icon: 'uploadFile' }],
    },
    {
      type: 'row',
      key: 'local:city',
      name: 'City',
      icon: 'image',
      depth: 1,
      branches: [false],
      parentKey: 'local',
      container: false,
      expanded: false,
      visible: true,
      progress: { completed: 75, mismatched: 5, unpainted: 20, known: 100, total: 100 },
      colourProgress: [
        {
          index: 0,
          name: 'Black',
          hex: '#000000',
          completed: 10,
          mismatched: 2,
          unpainted: 3,
          known: 15,
          total: 15,
        },
      ],
      renamable: true,
      draggable: true,
      setSize: 1,
      positionInSet: 1,
    },
  ],
}

describe('template tree', () => {
  it('debounces search and emits sort, expansion, visibility, and action intents', () => {
    vi.useFakeTimers()
    const onIntent = vi.fn()
    const component = mount(TemplateTree, { target: document.body, props: { model, onIntent } })
    flushSync()

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search templates"]')
    if (search === null) throw new Error('missing search')
    search.value = 'city'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    vi.advanceTimersByTime(99)
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'search', query: 'city' })
    vi.advanceTimersByTime(1)
    expect(onIntent).toHaveBeenCalledWith({ type: 'search', query: 'city' })

    document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'toggle-expanded', key: 'local' })

    document.querySelector<HTMLInputElement>('[aria-label="Show City"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'toggle-visible',
      key: 'local:city',
      visible: false,
    })

    document.querySelector<HTMLButtonElement>('[aria-label="Import template"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'action', key: 'local', actionId: 'import' })
    void unmount(component)
  })

  it('keeps the compact Daisy tree controls and explicit visibility icon', () => {
    const component = mount(TemplateTree, { target: document.body, props: { model } })
    flushSync()

    const search = document.querySelector<HTMLElement>('.search')
    const toolbar = document.querySelector<HTMLElement>('.toolbar')
    const rowAction = document.querySelector<HTMLElement>('[aria-label="Import template"]')
    const visibility = document.querySelector<HTMLElement>('.visibility > span')
    expect(getComputedStyle(search as Element).blockSize).toBe('2rem')
    expect(getComputedStyle(toolbar as Element).margin).toBe('12px 16px 0px')
    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    expect(getComputedStyle(rowAction as Element).blockSize).toBe('2rem')
    expect(getComputedStyle(row as Element).padding).toBe('4px 8px')
    expect(getComputedStyle(visibility as Element).blockSize).toBe('1.5rem')
    expect(visibility?.querySelector('svg')).not.toBeNull()
    void unmount(component)
  })

  it('swaps compact progress and row actions in the same fixed-width tail', () => {
    const entries: TemplateTreeModel['entries'] = model.entries.map((entry) =>
      entry.type === 'row' && entry.key === 'local:city'
        ? {
            ...entry,
            actions: [{ id: 'download', label: 'Download', icon: 'download' }],
          }
        : entry,
    )
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, entries } },
    })
    flushSync()

    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local:city"]')
    const tail = row?.querySelector<HTMLElement>(':scope > .row-tail')
    expect(tail?.querySelector(':scope > .progress')).not.toBeNull()
    expect(tail?.querySelector(':scope > .actions [aria-label="Download"]')).not.toBeNull()
    expect(tail?.querySelector(':scope > .actions [aria-label="Expand progress"]')).not.toBeNull()
    expect(row?.querySelector(':scope > .progress')).toBeNull()
    expect(row?.querySelector(':scope > .actions')).toBeNull()
    void unmount(component)
  })

  it('uses roving focus and exposes progress detail on demand', async () => {
    const component = mount(TemplateTree, { target: document.body, props: { model } })
    flushSync()
    const local = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    local?.focus()
    local?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement?.getAttribute('data-caelestis-tree-key')).toBe('local:city')

    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')
    expand?.focus()
    expand?.click()
    flushSync()
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Collapse progress'),
    )
    expect(document.querySelector('.progress-legend .completed')?.textContent).toBe('75')
    expect(document.querySelector('.progress-legend .mismatched')?.textContent).toBe('5')
    expect(document.querySelector('.progress-legend .unpainted')?.textContent).toBe('20')
    const connector = document.querySelector<HTMLElement>(
      '[data-caelestis-tree-key="local:city"] .connector',
    )
    expect(connector?.tagName).toBe('SPAN')
    expect(getComputedStyle(connector?.querySelector('.connector-elbow') as Element).top).toBe(
      '20px',
    )
    expect(getComputedStyle(connector?.closest('.row') as Element).alignContent).toBe('flex-start')
    const disclosure = document.querySelector<HTMLElement>('.progress-disclosure')
    const detailPercent = disclosure?.querySelector<HTMLElement>('.percent')
    const detailAction = disclosure?.querySelector<HTMLElement>('.progress-detail-action')
    expect(disclosure).not.toBeNull()
    expect(disclosure?.querySelector('.progress-summary > .progress-legend')).not.toBeNull()
    expect(getComputedStyle(detailPercent as Element).fontSize).toBe('10px')
    expect(getComputedStyle(detailAction as Element).position).toBe('absolute')
    expect(document.querySelector('[aria-label="Collapse progress"]')).not.toBeNull()
    const showColours = document.querySelector<HTMLButtonElement>(
      '[aria-label="Show colour progress"]',
    )
    showColours?.focus()
    showColours?.click()
    flushSync()
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide colour progress'),
    )
    const colour = document.querySelector<HTMLElement>('.colour-progress-row')
    expect(colour?.textContent).toContain('Black')
    expect(colour?.querySelector('.meter-wrap')).not.toBeNull()
    expect(document.querySelector('[aria-label="Hide colour progress"]')).not.toBeNull()
    void unmount(component)
  })

  it('anchors compact connectors to the actual heading height', () => {
    const plain = {
      ...model.entries[1],
      key: 'local:plain',
      name: 'Plain',
      progress: undefined,
      colourProgress: undefined,
      renamable: false,
      draggable: false,
      positionInSet: 2,
    } satisfies TemplateTreeModel['entries'][number]
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, entries: [...model.entries, plain] } },
    })
    flushSync()

    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local:plain"]')
    expect(row?.classList.contains('tall-heading')).toBe(false)
    expect(getComputedStyle(row?.querySelector('.connector-elbow') as Element).top).toBe('16px')
    void unmount(component)
  })

  it('reorders expanded containers against their next sibling', () => {
    const onIntent = vi.fn()
    const entries: TemplateTreeModel['entries'] = [
      { ...model.entries[0], expanded: true, setSize: 2, positionInSet: 1 },
      model.entries[1],
      {
        ...model.entries[0],
        key: 'caelestis',
        name: 'Caelestis',
        expanded: false,
        setSize: 2,
        positionInSet: 2,
      },
    ]
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, entries }, onIntent },
    })
    flushSync()

    const local = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    local?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    )

    expect(onIntent).toHaveBeenCalledWith({
      type: 'drop',
      draggedKey: 'local',
      targetKey: 'caelestis',
      position: 'after',
    })
    void unmount(component)
  })

  it('owns context menus and operation choosers while emitting typed intents', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          contextMenu: {
            id: 'menu-1',
            x: 20,
            y: 30,
            items: [{ id: 'delete', label: 'Delete', icon: 'trash', danger: true }],
          },
          operation: {
            id: 'move-1',
            label: 'Move City to:',
            options: [
              { value: 'a', label: 'Folder A' },
              { value: 'b', label: 'Folder B' },
            ],
            confirmLabel: 'Move',
          },
        },
        onIntent,
      },
    })
    flushSync()

    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'context-menu-action',
      menuId: 'menu-1',
      actionId: 'delete',
    })

    const chooser = document.querySelector<HTMLSelectElement>('[aria-label="Move City to:"]')
    if (chooser === null) throw new Error('missing operation chooser')
    chooser.value = 'b'
    chooser.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    document.querySelector<HTMLButtonElement>('.operation button.primary')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'tree-operation-confirm',
      operationId: 'move-1',
      value: 'b',
    })
    void unmount(component)
  })

  it('shows drag feedback and emits the resolved drop position', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, { target: document.body, props: { model, onIntent } })
    flushSync()
    const city = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local:city"]')
    const local = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    const tree = document.querySelector<HTMLElement>('[role="tree"]')
    city?.dispatchEvent(new DragEvent('dragstart', { bubbles: true }))
    local?.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientY: 0 }))
    flushSync()
    expect(local?.classList.contains('drop-inside')).toBe(true)
    tree?.dispatchEvent(new DragEvent('drop', { bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({
      type: 'drop',
      draggedKey: 'local:city',
      targetKey: 'local',
      position: 'inside',
    })
    void unmount(component)
  })

  it('keeps rename drafts local and emits only the committed name', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, renamingKey: 'local:city' }, onIntent },
    })
    flushSync()

    const input = document.querySelector<HTMLInputElement>('[data-caelestis-rename]')
    if (input === null) throw new Error('missing rename input')
    input.value = 'Forsaken City'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({
      type: 'rename',
      key: 'local:city',
      name: 'Forsaken City',
    })
    void unmount(component)
  })
})
