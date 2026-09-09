// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte'
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
  it.each([false, true])(
    'opens named grid progress and restores focus for container=%s',
    async (container) => {
      const component = mount(TemplateTree, {
        target: document.body,
        props: {
          model: {
            ...model,
            displayMode: 'grid',
            entries: model.entries.map((entry) =>
              entry.key === 'local:city' ? { ...entry, container } : entry,
            ),
          },
          allowGrid: true,
        },
      })
      flushSync()
      const card = document.querySelector('[data-caelestis-tree-key="local:city"]')
      const trigger = card?.querySelector<HTMLButtonElement>(
        '[aria-label="View progress for City"]',
      )
      if (trigger === null || trigger === undefined) throw new Error('missing progress control')
      trigger.click()
      await tick()
      await tick()
      const pane = document.querySelector('[aria-label="Progress for City"]')
      expect(pane?.querySelector('h3')?.textContent).toBe('City')
      expect(pane?.textContent).toContain('Complete')
      expect(pane?.textContent).toContain('Mismatched')
      expect(pane?.textContent).toContain('Black')
      expect(card?.querySelector('.progress-detail')).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close progress')
      const escapeKey = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      document.activeElement?.dispatchEvent(escapeKey)
      await tick()
      await tick()
      expect(escapeKey.defaultPrevented).toBe(true)
      expect(document.querySelector('[aria-label="Progress for City"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      void unmount(component)
    },
  )

  it.each(['tree', 'grid'] as const)(
    'preserves row order, focus, and core actions in %s mode',
    (displayMode) => {
      const onIntent = vi.fn()
      const entries = model.entries.map((entry) =>
        entry.type === 'row' && !entry.container
          ? {
              ...entry,
              contextMenu: true,
              leadingActions: [{ id: 'go', label: 'Go to', icon: 'search' as const }],
              actions: [{ id: 'copy', label: 'Copy to a server', icon: 'uploadFile' as const }],
            }
          : entry,
      )
      const component = mount(TemplateTree, {
        target: document.body,
        props: {
          model: { ...model, entries, displayMode, focusedKey: 'local:city' },
          allowGrid: true,
          onIntent,
        },
      })
      flushSync()
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-caelestis-tree-key]')].map(
          (row) => row.dataset.caelestisTreeKey,
        ),
      ).toEqual(['local', 'local:city'])
      expect(
        document.querySelector('[aria-current="true"]')?.getAttribute('data-caelestis-tree-key'),
      ).toBe('local:city')
      const click = (label: string) =>
        document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click()
      click('Go to')
      click('Copy to a server')
      expect(onIntent).toHaveBeenCalledWith({ type: 'action', key: 'local:city', actionId: 'go' })
      expect(onIntent).toHaveBeenCalledWith({ type: 'action', key: 'local:city', actionId: 'copy' })
      document.querySelector<HTMLInputElement>('input[aria-label="Show City"]')?.click()
      expect(onIntent).toHaveBeenCalledWith({
        type: 'toggle-visible',
        key: 'local:city',
        visible: false,
      })
      if (displayMode === 'grid') {
        click('Actions for City')
        expect(onIntent).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'context-menu', key: 'local:city' }),
        )
      }
      const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local:city"]')
      if (row === null) throw new Error('missing city row')
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(document.activeElement?.getAttribute('data-caelestis-tree-key')).toBe('local')
      onIntent.mockClear()
      click(displayMode === 'tree' ? 'Preview grid view' : 'Tree view')
      expect(onIntent.mock.calls).toEqual([
        [{ type: 'display-mode', mode: displayMode === 'tree' ? 'grid' : 'tree' }],
      ])
      void unmount(component)
    },
  )

  it('keeps preview metadata and nested folder paths visible', () => {
    const [root, leaf] = model.entries
    if (root === undefined || leaf === undefined) throw new Error('missing fixture rows')
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        allowGrid: true,
        model: {
          ...model,
          displayMode: 'grid',
          entries: [
            root,
            {
              ...root,
              type: 'row',
              key: 'folder',
              name: 'Landscapes',
              icon: 'folder',
              depth: 1,
              parentKey: 'local',
              container: true,
              expanded: true,
              visible: true,
              setSize: 1,
              positionInSet: 1,
            },
            {
              ...leaf,
              type: 'row',
              key: 'city',
              name: 'City',
              icon: 'image',
              depth: 2,
              parentKey: 'folder',
              container: false,
              expanded: false,
              visible: true,
              setSize: 1,
              positionInSet: 1,
              preview: { width: 100, height: 200, ownership: 'Local' },
            },
          ],
        },
      },
    })
    flushSync()
    const card = document.querySelector('[data-caelestis-tree-key="city"]')
    if (card === null) throw new Error('missing preview card')
    expect(card.textContent).toContain('Landscapes')
    expect(card.textContent).toContain('100×200')
    expect(card.textContent).toContain('Preview unavailable')
    expect(card.querySelector('canvas')?.getAttribute('aria-label')).toBe('City template art')
    expect(
      document
        .querySelector('button[aria-label="Preview grid view"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
    void unmount(component)
  })
  it('allows keyboard server reordering during automatic sorting and skips fixed Local', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          sort: { field: 'progress', direction: 'asc' },
          entries: ['local', 'server:a', 'server:b'].map((key, index) => ({
            type: 'row',
            key,
            name: key,
            icon: 'server',
            depth: 0,
            parentKey: null,
            container: true,
            expanded: false,
            visible: true,
            draggable: key !== 'local',
            setSize: 3,
            positionInSet: index + 1,
          })),
        },
        onIntent,
      },
    })
    flushSync()
    const press = (key: string) =>
      document
        .querySelector(`[data-caelestis-tree-key="${key}"]`)
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
        )
    press('server:a')
    expect(onIntent).not.toHaveBeenCalled()
    press('server:b')
    expect(onIntent).toHaveBeenCalledWith({
      type: 'drop',
      draggedKey: 'server:b',
      targetKey: 'server:a',
      position: 'before',
    })
    void unmount(component)
  })
  it('ignores keyboard reorder for rows the adapter marks as fixed', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          sort: { field: 'recent', direction: 'desc' },
          entries: [
            ...model.entries.map((entry) => ({ ...entry, draggable: false })),
            {
              type: 'row',
              key: 'other',
              name: 'Other',
              icon: 'folder',
              depth: 0,
              parentKey: null,
              container: true,
              expanded: false,
              visible: true,
              setSize: 2,
              positionInSet: 2,
            },
          ],
        },
        onIntent,
      },
    })
    flushSync()
    document
      .querySelector('[data-caelestis-tree-key="local"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
      )
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'drop' }))
    void unmount(component)
  })
  it.each([
    ['regression', 'regression-alarm', 'Contains templates with regression'],
    ['sustained-griefing', 'grief-alarm', 'Contains griefed templates'],
  ] as const)(
    'shows %s on a collapsed folder without a lifecycle indicator',
    (kind, className, title) => {
      const component = mount(TemplateTree, {
        target: document.body,
        props: {
          model: {
            ...model,
            entries: model.entries.map((entry) =>
              entry.type === 'row' && entry.container
                ? { ...entry, expanded: false, descendantAlarmKind: kind }
                : entry,
            ),
          },
        },
      })
      flushSync()
      const row = document.querySelector('.row[aria-expanded="false"]')
      expect(row?.querySelector('[role="status"]')?.getAttribute('title')).toBe(title)
      expect(row?.classList.contains(className)).toBe(true)
      expect(
        row?.classList.contains(kind === 'regression' ? 'grief-alarm' : 'regression-alarm'),
      ).toBe(false)
      expect(row?.querySelector('[aria-label="Finished"]')).toBeNull()
      expect(row?.querySelector('.progress-detail')).toBeNull()
      void unmount(component)
    },
  )
  it('preserves focused-row controls and progress alongside combined lifecycle and alarm state', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          focusedKey: 'local:city',
          entries: model.entries.map((entry) =>
            entry.type === 'row' && entry.key === 'local:city'
              ? { ...entry, lifecycle: { finished: true, frozen: true, griefed: true } }
              : entry,
          ),
        },
        onIntent,
      },
    })
    flushSync()
    const row = document.querySelector('[data-caelestis-tree-key="local:city"]')
    expect(row?.getAttribute('aria-current')).toBe('true')
    expect(row?.querySelector('[aria-label="75% complete"]')).not.toBeNull()
    expect(row?.querySelector('.template-icon [aria-label="Finished"]')?.textContent).toBe('✅')
    expect(row?.querySelector('[aria-label="Timelapse frozen"]')).toBeNull()
    expect(row?.querySelector('.row-heading [role="status"] .alarm-mark')?.textContent).toBe('⚠️')
    expect(row?.querySelector('[role="status"]')?.getAttribute('title')).toBe('Grief detected')
    expect(row?.querySelector('.progress-detail')).toBeNull()
    row?.querySelector<HTMLInputElement>('[aria-label="Show City"]')?.click()
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({
      type: 'toggle-visible',
      key: 'local:city',
      visible: false,
    })
    void unmount(component)
  })

  it.each([
    [true, true, 'Finished', '✅'],
    [false, true, 'Timelapse frozen', '🧊'],
  ])(
    'overlays one passive status without a detail line (%s, %s)',
    (finished, frozen, label, emoji) => {
      const component = mount(TemplateTree, {
        target: document.body,
        props: {
          model: {
            ...model,
            entries: model.entries.map((entry) =>
              entry.type === 'row' && !entry.container
                ? { ...entry, lifecycle: { finished, frozen, griefed: false } }
                : entry,
            ),
          },
        },
      })
      flushSync()
      const row = document.querySelector('[data-caelestis-tree-key="local:city"]')
      expect(row?.querySelectorAll('.lifecycle [role="img"]')).toHaveLength(1)
      expect(
        row?.querySelector(`.template-icon .overlay[aria-label="${label}"]`)?.textContent,
      ).toBe(emoji)
      expect(row?.querySelector('[role="status"]')).toBeNull()
      expect(row?.querySelector('.name')?.textContent).toBe('City')
      void unmount(component)
    },
  )

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

  it('keeps label and checkbox visibility activation separate from row disclosure', () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          entries: model.entries.map((entry) =>
            entry.type === 'row' && entry.key === 'local' ? { ...entry, expanded: true } : entry,
          ),
        },
        onIntent,
      },
    })
    flushSync()

    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    const label = row?.querySelector<HTMLLabelElement>('.visibility')
    const checkbox = label?.querySelector<HTMLInputElement>('input')

    label?.click()
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(onIntent.mock.calls).toEqual([
      [{ type: 'toggle-visible', key: 'local', visible: false }],
    ])

    onIntent.mockClear()
    checkbox?.focus()
    checkbox?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    checkbox?.click()
    expect(onIntent.mock.calls).toEqual([[{ type: 'toggle-visible', key: 'local', visible: true }]])

    onIntent.mockClear()
    row?.click()
    expect(onIntent.mock.calls).toEqual([[{ type: 'toggle-expanded', key: 'local' }]])
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
    expect(getComputedStyle(toolbar as Element).margin).toBe('12px 16px')
    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    expect(getComputedStyle(rowAction as Element).blockSize).toBe('2rem')
    expect(getComputedStyle(row as Element).padding).toBe('4px 8px')
    expect(getComputedStyle(visibility as Element).blockSize).toBe('1.5rem')
    expect(visibility?.querySelector('svg')).not.toBeNull()
    void unmount(component)
  })

  it('keeps the pre-refactor Daisy variants for standalone tree actions', () => {
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          entries: [
            {
              type: 'action',
              key: 'local-import',
              depth: 1,
              variant: 'compact',
              title: 'A .wplace file, a Blue Marble export, or an image',
              action: { id: 'run', label: 'Import a template', icon: 'uploadFile' },
            },
            {
              type: 'action',
              key: 'add-server',
              depth: 0,
              variant: 'ghost',
              showIcon: true,
              title: 'Add another server',
              action: { id: 'run', label: 'Add another server', icon: 'extension' },
            },
          ],
        },
      },
    })
    flushSync()

    const importWrap = document.querySelector<HTMLElement>('.standalone.compact')
    const importButton = importWrap?.querySelector<HTMLButtonElement>('button')
    const addWrap = document.querySelector<HTMLElement>('.standalone.ghost')
    const addButton = addWrap?.querySelector<HTMLButtonElement>('button')
    const importStyle = getComputedStyle(importButton as Element)
    const addStyle = getComputedStyle(addButton as Element)

    expect(getComputedStyle(importWrap as Element).padding).toBe('0px 12px 8px 36px')
    expect(importStyle.blockSize).toBe('1.5rem')
    expect(importStyle.getPropertyValue('--button-padding')).toBe('0.5rem')
    expect(importStyle.getPropertyValue('--button-font-size')).toBe('0.6875rem')
    expect(importButton?.title).toBe('A .wplace file, a Blue Marble export, or an image')
    expect(importButton?.querySelector('svg')).toBeNull()

    expect(getComputedStyle(addWrap as Element).padding).toBe('8px 12px 0px')
    expect(addStyle.blockSize).toBe('2rem')
    expect(addStyle.getPropertyValue('--button-padding')).toBe('0.75rem')
    expect(addStyle.gap).toBe('0.375rem')
    expect(addStyle.getPropertyValue('--button-font-size')).toBe('0.75rem')
    expect(addButton?.querySelector('svg')).not.toBeNull()
    void unmount(component)
  })

  it('swaps compact progress and row actions in the same tail', () => {
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
    const tail = row?.querySelector<HTMLElement>('.row-heading > .row-tail')
    expect(tail?.querySelector(':scope > .progress')).not.toBeNull()
    expect(tail?.querySelector(':scope > .actions [aria-label="Download"]')).not.toBeNull()
    expect(tail?.querySelector(':scope > .actions [aria-label="Expand progress"]')).not.toBeNull()
    expect(row?.querySelector(':scope > .progress')).toBeNull()
    expect(row?.querySelector(':scope > .actions')).toBeNull()
    void unmount(component)
  })

  it('keeps exact pixel labels when expanded counts are compact', () => {
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          entries: model.entries.map((entry) =>
            entry.type === 'row' && entry.key === 'local:city'
              ? {
                  ...entry,
                  progress: {
                    completed: 3012480,
                    mismatched: 1,
                    unpainted: 12543,
                    known: 3025024,
                    total: 3025024,
                  },
                }
              : entry,
          ),
        },
      },
    })
    flushSync()
    document.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')?.click()
    flushSync()
    const completed = document.querySelector<HTMLElement>('.progress-legend .completed')
    expect(completed?.textContent).toBe('3.01M')
    expect(completed?.title).toBe('3,012,480 pixels completed')
    expect(completed?.getAttribute('aria-label')).toBe(completed?.title)
    expect(document.querySelector('.progress-legend .mismatched')?.getAttribute('aria-label')).toBe(
      '1 pixel mismatched',
    )
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
    expect(getComputedStyle(connector?.closest('.row') as Element).flexDirection).toBe('column')
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

  it('aligns folder and template progress details at equal and nested depths', () => {
    const progress = {
      completed: 75,
      mismatched: 5,
      unpainted: 20,
      known: 100,
      total: 100,
    }
    const colourProgress = [
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
    ]
    const entries: TemplateTreeModel['entries'] = [
      {
        ...model.entries[0],
        key: 'folder',
        name: 'Folder',
        depth: 1,
        branches: [true],
        expanded: true,
        progress,
        colourProgress,
      },
      {
        ...model.entries[1],
        key: 'template',
        name: 'Template',
        branches: [false],
        progress,
        colourProgress,
      },
      {
        ...model.entries[0],
        key: 'nested-folder',
        name: 'Nested folder',
        depth: 2,
        branches: [true, true],
        expanded: true,
        progress,
        colourProgress,
      },
      {
        ...model.entries[1],
        key: 'nested-template',
        name: 'Nested template',
        depth: 2,
        branches: [true, false],
        progress,
        colourProgress,
      },
    ]
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, entries } },
    })
    flushSync()

    document
      .querySelectorAll<HTMLButtonElement>('[aria-label="Expand progress"]')
      .forEach((button) => {
        button.click()
      })
    flushSync()
    document
      .querySelectorAll<HTMLButtonElement>('[aria-label="Show colour progress"]')
      .forEach((button) => {
        button.click()
      })
    flushSync()

    const pixelTerm = (value: string): number => Number(value.match(/(\d+)px/)?.[1] ?? 0)
    const geometry = (key: string) => {
      const row = document.querySelector<HTMLElement>(`[data-caelestis-tree-key="${key}"]`)
      const detail = row?.querySelector<HTMLElement>('.progress-detail')
      if (row === null || row === undefined || detail === null || detail === undefined) {
        throw new Error(`missing progress detail for ${key}`)
      }
      const detailStyle = getComputedStyle(detail)
      return {
        inlineStart:
          pixelTerm(row.style.paddingInlineStart) +
          pixelTerm(row.style.getPropertyValue('--progress-detail-offset')),
        inlineEnd:
          pixelTerm(getComputedStyle(row).paddingRight) + pixelTerm(detailStyle.paddingRight),
        hasSummary: detail.querySelector('.progress-summary') !== null,
        hasColours: detail.querySelector('.colour-progress') !== null,
      }
    }
    const folder = geometry('folder')
    const template = geometry('template')
    const nestedFolder = geometry('nested-folder')
    const nestedTemplate = geometry('nested-template')

    expect(folder).toEqual(template)
    expect(nestedFolder).toEqual(nestedTemplate)
    expect(nestedFolder.inlineStart - folder.inlineStart).toBe(18)
    expect(folder.inlineEnd).toBeGreaterThan(0)
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
            rowKey: 'local:city',
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

  it('opens the context menu from a touch press-and-hold and keeps fly-to among hover actions', () => {
    vi.useFakeTimers()
    const onIntent = vi.fn()
    const entries = model.entries.map((entry) =>
      entry.type === 'row' && !entry.container
        ? {
            ...entry,
            contextMenu: true,
            leadingActions: [{ id: 'go', label: 'Go to', icon: 'search' as const }],
          }
        : entry,
    )
    const component = mount(TemplateTree, {
      target: document.body,
      props: { model: { ...model, entries }, onIntent },
    })
    flushSync()
    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local:city"]')
    if (row === null) throw new Error('missing city row')
    expect(row.querySelector('.row-heading > .icon-action')).toBeNull()
    expect(row.querySelector('.actions [aria-label="Go to"]')).not.toBeNull()

    const pointer = (type: string, init: PointerEventInit = {}): void => {
      row.dispatchEvent(
        new PointerEvent(type, { bubbles: true, pointerType: 'touch', isPrimary: true, ...init }),
      )
    }
    pointer('pointerdown', { clientX: 40, clientY: 50, pointerId: 1 })
    pointer('pointermove', { clientX: 44, clientY: 52, pointerId: 1 })
    vi.advanceTimersByTime(300)
    expect(onIntent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({
      type: 'context-menu',
      key: 'local:city',
      x: 40,
      y: 50,
    })
    onIntent.mockClear()
    pointer('contextmenu', { pointerId: 1, cancelable: true })
    row.click()
    expect(onIntent).not.toHaveBeenCalled()

    pointer('pointerdown', { clientX: 40, clientY: 50, pointerId: 2 })
    pointer('pointermove', { clientX: 70, clientY: 50, pointerId: 2 })
    vi.advanceTimersByTime(600)
    expect(onIntent).not.toHaveBeenCalled()
    pointer('pointerdown', { clientX: 40, clientY: 50, pointerId: 3, pointerType: 'mouse' })
    vi.advanceTimersByTime(600)
    expect(onIntent).not.toHaveBeenCalled()
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }),
    )
    expect(onIntent).toHaveBeenCalledWith({ type: 'context-menu', key: 'local:city', x: 5, y: 6 })
    void unmount(component)
  })

  it.each([
    ['contextmenu', 'click'],
    ['click', 'contextmenu'],
  ])("suppresses a held folder's trailing %s then %s until the next gesture", (first, second) => {
    vi.useFakeTimers()
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          entries: model.entries.map((entry) => ({ ...entry, contextMenu: true })),
        },
        onIntent,
      },
    })
    flushSync()
    const row = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    if (row === null) throw new Error('missing folder row')
    const pointer = (type: string, init: PointerEventInit = {}): void => {
      row.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: 'touch',
          isPrimary: true,
          pointerId: 1,
          ...init,
        }),
      )
    }
    pointer('pointerdown')
    vi.advanceTimersByTime(2000)
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({
      type: 'context-menu',
      key: 'local',
      x: 0,
      y: 0,
    })
    onIntent.mockClear()
    // Another device can act while the original finger is still held down.
    pointer('pointerdown', { pointerId: 2, pointerType: 'mouse' })
    pointer('pointerup', { pointerId: 2, pointerType: 'mouse' })
    pointer('click', { pointerId: 2, pointerType: 'mouse' })
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'toggle-expanded', key: 'local' })
    onIntent.mockClear()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
    pointer('contextmenu', { pointerId: -1, pointerType: '' })
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({
      type: 'context-menu',
      key: 'local',
      x: 0,
      y: 0,
    })
    onIntent.mockClear()
    pointer('pointerup')
    for (const type of [first, second]) {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 1,
      })
      row.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(onIntent).not.toHaveBeenCalled()

    pointer('pointerdown')
    pointer('pointerup')
    row.click()
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'toggle-expanded', key: 'local' })
    void unmount(component)
  })

  it('separates menu groups and opens a submenu by keyboard, tap, and hover', async () => {
    const onIntent = vi.fn()
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          ...model,
          contextMenu: {
            id: 'menu-2',
            rowKey: 'local:city',
            x: 20,
            y: 30,
            items: [
              { id: 'go', label: 'Go to', icon: 'search', group: 'navigate' },
              { id: 'export', label: 'Export .wplace', icon: 'download', group: 'organise' },
              { id: 'move', label: 'Move', icon: 'move', group: 'organise' },
              {
                id: 'mark',
                label: 'Mark as…',
                icon: 'taskAlt',
                group: 'state',
                children: [
                  { id: 'finished', label: 'Finished', icon: 'flag', checked: true },
                  { id: 'frozen', label: 'Frozen', icon: 'snowflake', checked: false },
                ],
              },
              { id: 'delete', label: 'Delete', icon: 'trash', group: 'danger', danger: true },
            ],
          },
        },
        onIntent,
      },
    })
    flushSync()
    const key = (target: Element | null, key: string): void => {
      target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      flushSync()
    }
    const hover = (target: Element | null, pointerType: string): void => {
      target?.dispatchEvent(new PointerEvent('pointerenter', { pointerType }))
      flushSync()
    }
    const rows = (): string[] =>
      Array.from(
        document.querySelectorAll('.context-menu [role^="menuitem"]'),
        (row) => row.textContent?.trim() ?? '',
      )

    expect(document.querySelectorAll('.context-menu [role="separator"]')).toHaveLength(3)
    const trigger = document.querySelector<HTMLButtonElement>(
      '.context-menu [aria-haspopup="menu"]',
    )
    if (trigger === null) throw new Error('missing submenu trigger')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(rows()).toEqual(['Go to', 'Export .wplace', 'Move', 'Mark as…', 'Delete'])

    trigger.focus()
    key(trigger, 'ArrowRight')
    await tick()
    await tick()
    const finished = document.querySelector<HTMLButtonElement>(
      '.context-menu [role="menuitemcheckbox"]',
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(finished?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(finished)
    key(finished, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('Frozen')
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('false')
    key(document.activeElement, 'ArrowDown')
    expect(document.activeElement).toBe(finished)
    key(finished, 'Escape')
    expect(document.querySelector('.context-menu [role="menuitemcheckbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(onIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dismiss-context-menu' }),
    )

    hover(trigger, 'touch')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.click()
    flushSync()
    await tick()
    await tick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toContain('Finished')
    key(trigger, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('Delete')
    document.querySelector<HTMLButtonElement>('.context-menu [role="menuitemcheckbox"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'context-menu-action',
      menuId: 'menu-2',
      actionId: 'finished',
    })

    hover(document.querySelector('.context-menu [role="menuitem"]'), 'mouse')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    hover(trigger, 'mouse')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    hover(document.querySelector('.context-menu [role="menuitemcheckbox"]'), 'mouse')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    for (const closeKey of ['ArrowLeft', 'Escape']) {
      const first = document.querySelector<HTMLButtonElement>('.context-menu [role="menuitem"]')
      first?.focus()
      hover(trigger, 'mouse')
      expect(document.activeElement).toBe(first)
      key(document.activeElement, closeKey)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(trigger)
      expect(onIntent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'dismiss-context-menu' }),
      )
    }
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
