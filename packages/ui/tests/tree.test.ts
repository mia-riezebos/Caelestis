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
      parentKey: 'local',
      container: false,
      expanded: false,
      visible: true,
      progress: { completed: 75, mismatched: 5, unpainted: 20, known: 100, total: 100 },
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

  it('uses roving focus and exposes progress detail on demand', () => {
    const component = mount(TemplateTree, { target: document.body, props: { model } })
    flushSync()
    const local = document.querySelector<HTMLElement>('[data-caelestis-tree-key="local"]')
    local?.focus()
    local?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement?.getAttribute('data-caelestis-tree-key')).toBe('local:city')

    document.querySelector<HTMLButtonElement>('[aria-label="75% complete"]')?.click()
    flushSync()
    expect(document.body.textContent).toContain('75 completed')
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
