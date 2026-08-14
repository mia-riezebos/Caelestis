// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getState, moveLocalFolder, setState } from '../state.js'
import { type TreeCallbacks, treeContents } from './tree.js'

const eventWithTransfer = (type: string, dataTransfer: DataTransfer, clientY = 0): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

afterEach(() => {
  setState({
    servers: [],
    localFolders: [],
    customOrder: [],
    collapsed: [],
    sort: { field: 'custom', direction: 'asc' },
  })
  localStorage.clear()
})

describe('tree drag and drop', () => {
  it("ranks a row dropped into an expanded folder ahead of that folder's first child", async () => {
    setState({
      servers: [],
      localFolders: [
        { id: 'moving', parentId: null, name: 'Moving', visible: true },
        { id: 'destination', parentId: null, name: 'Destination', visible: true },
        { id: 'first-child', parentId: 'destination', name: 'First child', visible: true },
      ],
      customOrder: [],
      collapsed: [],
      sort: { field: 'custom', direction: 'asc' },
    })
    const onMoveLocal = vi.fn(
      async (draggedKey: string, parentKey: string | null, _beforeKey: string | null) => {
        moveLocalFolder(
          draggedKey.slice('lf:'.length),
          parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null,
        )
        return draggedKey
      },
    )
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onContextMenu: vi.fn(),
      onGoTo: vi.fn(),
      onPlace: vi.fn(),
      onCopyToServer: vi.fn(),
      onError: vi.fn(),
      onMoveLocal,
      onDropInServer: vi.fn(),
    }
    const tree = treeContents(callbacks, vi.fn())
    const moving = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:moving"]')
    const destination = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:destination"]')
    if (moving === null || destination === null) throw new Error('expected rendered folder rows')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'lf:moving')

    moving.dispatchEvent(eventWithTransfer('dragstart', transfer))
    destination.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    destination.dispatchEvent(eventWithTransfer('drop', transfer, 1))
    await Promise.resolve()
    await Promise.resolve()

    expect(onMoveLocal).toHaveBeenCalledWith('lf:moving', 'lf:destination', 'lf:first-child')
    expect(getState().customOrder.indexOf('lf:moving')).toBeLessThan(
      getState().customOrder.indexOf('lf:first-child'),
    )
  })

  it('keeps hidden siblings in place when inserting after a visible filtered sibling', async () => {
    setState({
      servers: [],
      localFolders: [
        { id: 'destination', parentId: null, name: 'Destination', visible: true },
        { id: 'a', parentId: 'destination', name: 'Match A', visible: true },
        { id: 'hidden', parentId: 'destination', name: 'Hidden', visible: true },
        { id: 'b', parentId: 'destination', name: 'Match B', visible: true },
        { id: 'moving', parentId: null, name: 'Match moving', visible: true },
      ],
      customOrder: ['lf:moving', 'lf:destination', 'lf:a', 'lf:hidden', 'lf:b'],
      collapsed: ['lf:b'],
      sort: { field: 'custom', direction: 'asc' },
    })
    const onMoveLocal = vi.fn(
      async (draggedKey: string, parentKey: string | null, _beforeKey: string | null) => {
        moveLocalFolder(
          draggedKey.slice('lf:'.length),
          parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null,
        )
        return draggedKey
      },
    )
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onContextMenu: vi.fn(),
      onGoTo: vi.fn(),
      onPlace: vi.fn(),
      onCopyToServer: vi.fn(),
      onError: vi.fn(),
      onMoveLocal,
      onDropInServer: vi.fn(),
    }
    const tree = treeContents(callbacks, vi.fn(), 'match')
    const moving = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:moving"]')
    const b = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:b"]')
    if (moving === null || b === null) throw new Error('expected rendered filtered rows')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'lf:moving')

    moving.dispatchEvent(eventWithTransfer('dragstart', transfer))
    b.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    b.dispatchEvent(eventWithTransfer('drop', transfer, 1))
    await Promise.resolve()
    await Promise.resolve()

    expect(onMoveLocal).toHaveBeenCalledWith('lf:moving', 'lf:destination', null)
    expect(
      getState().customOrder.filter((key) =>
        ['lf:a', 'lf:hidden', 'lf:b', 'lf:moving'].includes(key),
      ),
    ).toEqual(['lf:a', 'lf:hidden', 'lf:b', 'lf:moving'])
  })

  it('ranks an inserted row first when every existing child is filtered out', async () => {
    setState({
      servers: [],
      localFolders: [
        { id: 'destination', parentId: null, name: 'Match destination', visible: true },
        { id: 'hidden-child', parentId: 'destination', name: 'Hidden child', visible: true },
        { id: 'moving', parentId: null, name: 'Match moving', visible: true },
      ],
      customOrder: ['lf:destination', 'lf:hidden-child', 'lf:moving'],
      collapsed: [],
      sort: { field: 'custom', direction: 'asc' },
    })
    const onMoveLocal = vi.fn(
      async (draggedKey: string, parentKey: string | null, _beforeKey: string | null) => {
        moveLocalFolder(
          draggedKey.slice('lf:'.length),
          parentKey?.startsWith('lf:') === true ? parentKey.slice('lf:'.length) : null,
        )
        return draggedKey
      },
    )
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onContextMenu: vi.fn(),
      onGoTo: vi.fn(),
      onPlace: vi.fn(),
      onCopyToServer: vi.fn(),
      onError: vi.fn(),
      onMoveLocal,
      onDropInServer: vi.fn(),
    }
    const tree = treeContents(callbacks, vi.fn(), 'match')
    const moving = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:moving"]')
    const destination = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:destination"]')
    if (moving === null || destination === null) throw new Error('expected rendered filtered rows')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'lf:moving')

    moving.dispatchEvent(eventWithTransfer('dragstart', transfer))
    destination.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    destination.dispatchEvent(eventWithTransfer('drop', transfer, 1))
    await Promise.resolve()
    await Promise.resolve()

    expect(onMoveLocal).toHaveBeenCalledWith('lf:moving', 'lf:destination', null)
    expect(
      getState().customOrder.filter((key) => ['lf:moving', 'lf:hidden-child'].includes(key)),
    ).toEqual(['lf:moving', 'lf:hidden-child'])
  })
})
