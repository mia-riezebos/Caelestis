import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import TemplateTree from '../src/tree/TemplateTree.svelte'
import type { TemplateTreeIntent, TemplateTreeModel } from '../src/types.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

describe('template tree keyboard and rename intents', () => {
  it('moves focus, expands a folder, and commits a renamed row through public intents', async () => {
    const intents: TemplateTreeIntent[] = []
    const model = {
      query: '',
      sort: { field: 'custom', direction: 'asc' },
      renamingKey: 'leaf',
      entries: [
        {
          type: 'row',
          key: 'folder',
          name: 'Folder',
          icon: 'folder',
          depth: 0,
          parentKey: null,
          container: true,
          expanded: false,
          visible: true,
          setSize: 2,
          positionInSet: 1,
        },
        {
          type: 'row',
          key: 'leaf',
          name: 'Old name',
          icon: 'image',
          depth: 1,
          parentKey: 'folder',
          container: false,
          expanded: false,
          visible: true,
          setSize: 1,
          positionInSet: 2,
          draggable: true,
        },
      ],
    } as TemplateTreeModel
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(TemplateTree, {
        target,
        props: { model, onIntent: (intent: TemplateTreeIntent) => intents.push(intent) },
      }),
    )
    await tick()
    const folder = target.querySelector('[data-caelestis-tree-key="folder"]') as HTMLElement
    folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const rename = target.querySelector('input[aria-label="Rename Old name"]') as HTMLInputElement
    rename.value = 'New name'
    rename.dispatchEvent(new Event('input', { bubbles: true }))
    rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(intents).toEqual([
      { type: 'toggle-expanded', key: 'folder' },
      { type: 'rename', key: 'leaf', name: 'New name' },
    ])
  })

  it('moves through context-menu actions by keyboard and emits the chosen action', async () => {
    const intents: TemplateTreeIntent[] = []
    const model = {
      query: '',
      sort: { field: 'custom', direction: 'asc' },
      entries: [
        {
          type: 'row',
          key: 'leaf',
          name: 'Leaf',
          icon: 'image',
          depth: 0,
          parentKey: null,
          container: false,
          expanded: false,
          visible: true,
          setSize: 1,
          positionInSet: 1,
        },
      ],
      contextMenu: {
        id: 'actions',
        rowKey: 'leaf',
        x: 5,
        y: 5,
        items: [
          { id: 'rename', label: 'Rename', icon: 'rename' },
          { id: 'remove', label: 'Remove', icon: 'trash' },
        ],
      },
    } satisfies TemplateTreeModel
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(TemplateTree, {
        target,
        props: { model, onIntent: (intent: TemplateTreeIntent) => intents.push(intent) },
      }),
    )
    await tick()
    await tick()
    const actions = Array.from(
      target.querySelectorAll('[data-caelestis-context-menu] [role="menuitem"]'),
    ) as HTMLButtonElement[]
    actions[0]!.focus()
    actions[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(actions[1])
    actions[1]!.click()
    expect(intents).toEqual([
      { type: 'context-menu-action', menuId: 'actions', actionId: 'remove' },
    ])
  })
})
