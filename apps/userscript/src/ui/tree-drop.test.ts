// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getState, moveLocalFolder, setState } from '../state.js'
import {
  forgetServerTree,
  nodeTreeKey,
  optimisticallyPlaceServerRow,
  rememberServerContents,
  serverTemplateTreeKey,
  type TreeCallbacks,
  treeContents,
} from './tree.js'

const SERVER_URL = 'https://server.example.com'
const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const SOURCE_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const DESTINATION_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49683'
const TEMPLATE_A_ID = '019fed50-87a1-7523-a88c-bdeafad49684'
const TEMPLATE_B_ID = '019fed50-87a1-7523-a88c-bdeafad49685'

const eventWithTransfer = (type: string, dataTransfer: DataTransfer, clientY = 0): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

afterEach(() => {
  forgetServerTree(SERVER_URL)
  setState({
    servers: [],
    localFolders: [],
    customOrder: [],
    collapsed: [],
    sort: { field: 'custom', direction: 'asc' },
  })
})

const connectedServer = () => ({
  url: SERVER_URL,
  info: { id: SERVER_ID, name: 'Server', auth: 'none' as const },
  token: null,
  status: 'connected' as const,
  isAdmin: true,
  season: 0,
})

const serverNode = (id: string, name: string) => ({
  id,
  parentId: null,
  path: `/${name.toLocaleLowerCase()}`,
  name,
  createdAt: 1_750_000_000_000,
})

const serverTemplate = (id: string, nodeId: string | null, name: string, updatedAt: number) => ({
  id,
  nodeId,
  name,
  version: 'v1',
  published: true,
  updatedAt,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  chunks: [],
})

describe('tree drag and drop', () => {
  it('keeps a fly-to action on server template rows', () => {
    const server = connectedServer()
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [],
      templates: [serverTemplate(TEMPLATE_A_ID, null, 'Template', 1)],
    })
    const onGoTo = vi.fn()
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onContextMenu: vi.fn(),
      onGoTo,
      onPlace: vi.fn(),
      onCopyToServer: vi.fn(),
      onError: vi.fn(),
      onMoveLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }

    const tree = treeContents(callbacks, vi.fn())
    const row = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
    )
    const flyTo = row?.querySelector<HTMLButtonElement>('[aria-label="Go to"]')

    expect(flyTo).not.toBeNull()
    flyTo?.click()
    expect(onGoTo).toHaveBeenCalledWith({
      kind: 'server',
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    })
  })

  it('renders a server reparent eagerly and can roll it back without waiting for a manifest', () => {
    const server = connectedServer()
    const source = serverNode(SOURCE_NODE_ID, 'Source')
    const destination = serverNode(DESTINATION_NODE_ID, 'Destination')
    const sourceKey = nodeTreeKey(server, SOURCE_NODE_ID)
    const destinationKey = nodeTreeKey(server, DESTINATION_NODE_ID)
    const templateKey = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
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
      onMoveLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const rowOrder = (): string[] =>
      [...treeContents(callbacks, vi.fn()).querySelectorAll<HTMLElement>('[data-caelestis-key]')]
        .map((row) => row.dataset.caelestisKey)
        .filter((key): key is string => key !== undefined)

    expect(rowOrder().indexOf(templateKey)).toBeLessThan(rowOrder().indexOf(destinationKey))
    const optimistic = optimisticallyPlaceServerRow(server, templateKey, DESTINATION_NODE_ID)
    expect(optimistic).not.toBeNull()
    const eager = rowOrder()
    expect(eager.indexOf(destinationKey)).toBeLessThan(eager.indexOf(templateKey))
    expect(eager.indexOf(sourceKey)).toBeLessThan(eager.indexOf(destinationKey))

    optimistic?.rollback()
    expect(rowOrder().indexOf(templateKey)).toBeLessThan(rowOrder().indexOf(destinationKey))

    const committed = optimisticallyPlaceServerRow(server, templateKey, DESTINATION_NODE_ID)
    committed?.commit()
    expect(rowOrder().indexOf(destinationKey)).toBeLessThan(rowOrder().indexOf(templateKey))
  })

  it('reorders templates within a server folder', async () => {
    const server = connectedServer()
    const node = serverNode(SOURCE_NODE_ID, 'Source')
    const firstKey = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    const secondKey = serverTemplateTreeKey(server, TEMPLATE_B_ID)
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [firstKey, secondKey],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [node],
      templates: [
        serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'First', 2),
        serverTemplate(TEMPLATE_B_ID, SOURCE_NODE_ID, 'Second', 1),
      ],
    })
    const onDropInServer = vi.fn(async () => firstKey)
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
      onMoveLocal: vi.fn(),
      onDropInServer,
    }
    const tree = treeContents(callbacks, vi.fn())
    const first = tree.querySelector<HTMLElement>(`[data-caelestis-key="${firstKey}"]`)
    const second = tree.querySelector<HTMLElement>(`[data-caelestis-key="${secondKey}"]`)
    if (first === null || second === null) throw new Error('expected rendered server templates')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', firstKey)

    first.dispatchEvent(eventWithTransfer('dragstart', transfer))
    second.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    second.dispatchEvent(eventWithTransfer('drop', transfer, 1))
    await Promise.resolve()

    expect(onDropInServer).toHaveBeenCalledWith(server, SOURCE_NODE_ID, firstKey, null)
    expect(getState().customOrder).toEqual([secondKey, firstKey])
  })

  it('reparents a server template dropped onto a collapsed server folder', async () => {
    const server = connectedServer()
    const source = serverNode(SOURCE_NODE_ID, 'Source')
    const destination = serverNode(DESTINATION_NODE_ID, 'Destination')
    const templateKey = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local', nodeTreeKey(server, DESTINATION_NODE_ID)],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
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
      onMoveLocal: vi.fn(),
      onDropInServer,
    }
    const tree = treeContents(callbacks, vi.fn())
    const template = tree.querySelector<HTMLElement>(`[data-caelestis-key="${templateKey}"]`)
    const destinationRow = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${nodeTreeKey(server, DESTINATION_NODE_ID)}"]`,
    )
    if (template === null || destinationRow === null)
      throw new Error('expected rendered server rows')
    vi.spyOn(destinationRow, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 30,
      left: 0,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    })
    const transfer = new DataTransfer()
    transfer.setData('text/plain', templateKey)

    template.dispatchEvent(eventWithTransfer('dragstart', transfer))
    destinationRow.dispatchEvent(eventWithTransfer('dragover', transfer, 15))
    destinationRow.dispatchEvent(eventWithTransfer('drop', transfer, 15))
    await Promise.resolve()
    await Promise.resolve()

    expect(onDropInServer).toHaveBeenCalledWith(server, DESTINATION_NODE_ID, templateKey, null)
  })

  it('honours the visible portal when drop lands in the tree gap around it', async () => {
    const server = connectedServer()
    const source = serverNode(SOURCE_NODE_ID, 'Source')
    const destination = serverNode(DESTINATION_NODE_ID, 'Destination')
    const templateKey = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local', nodeTreeKey(server, DESTINATION_NODE_ID)],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
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
      onMoveLocal: vi.fn(),
      onDropInServer,
    }
    const tree = treeContents(callbacks, vi.fn())
    const template = tree.querySelector<HTMLElement>(`[data-caelestis-key="${templateKey}"]`)
    const destinationRow = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${nodeTreeKey(server, DESTINATION_NODE_ID)}"]`,
    )
    if (template === null || destinationRow === null)
      throw new Error('expected rendered server rows')
    vi.spyOn(destinationRow, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 30,
      left: 0,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    })
    const transfer = new DataTransfer()
    transfer.setData('text/plain', templateKey)

    template.dispatchEvent(eventWithTransfer('dragstart', transfer))
    destinationRow.dispatchEvent(eventWithTransfer('dragover', transfer, 15))
    expect(tree.querySelector('[data-caelestis-placeholder]')).not.toBeNull()
    // The flex gap is owned by the tree, not by either adjacent element.
    tree.dispatchEvent(eventWithTransfer('drop', transfer, 15))
    await Promise.resolve()

    expect(onDropInServer).toHaveBeenCalledWith(server, DESTINATION_NODE_ID, templateKey, null)
  })

  it('reparents a server template directly under the server root', async () => {
    const server = connectedServer()
    const source = serverNode(SOURCE_NODE_ID, 'Source')
    const templateKey = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    rememberServerContents(server, {
      nodes: [source],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
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
      onMoveLocal: vi.fn(),
      onDropInServer,
    }
    const tree = treeContents(callbacks, vi.fn())
    const template = tree.querySelector<HTMLElement>(`[data-caelestis-key="${templateKey}"]`)
    const root = tree.querySelector<HTMLElement>(`[data-caelestis-key="server:${SERVER_URL}"]`)
    if (template === null || root === null) throw new Error('expected rendered server rows')
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 30,
      left: 0,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    })
    const transfer = new DataTransfer()
    transfer.setData('text/plain', templateKey)

    template.dispatchEvent(eventWithTransfer('dragstart', transfer))
    root.dispatchEvent(eventWithTransfer('dragover', transfer, 15))
    root.dispatchEvent(eventWithTransfer('drop', transfer, 15))
    await Promise.resolve()
    await Promise.resolve()

    expect(onDropInServer).toHaveBeenCalledWith(server, null, templateKey, expect.any(String))
  })
  it("ranks a child at the start of its own expanded parent's level", async () => {
    setState({
      servers: [],
      localFolders: [
        { id: 'parent', parentId: null, name: 'Parent', visible: true },
        { id: 'first', parentId: 'parent', name: 'First', visible: true },
        { id: 'moving', parentId: 'parent', name: 'Moving', visible: true },
      ],
      customOrder: ['lf:parent', 'lf:first', 'lf:moving'],
      collapsed: [],
      sort: { field: 'custom', direction: 'asc' },
    })
    const onMoveLocal = vi.fn(async (draggedKey: string) => draggedKey)
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
    const parent = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:parent"]')
    const moving = tree.querySelector<HTMLElement>('[data-caelestis-key="lf:moving"]')
    if (parent === null || moving === null) throw new Error('expected rendered folder rows')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'lf:moving')

    moving.dispatchEvent(eventWithTransfer('dragstart', transfer))
    parent.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    parent.dispatchEvent(eventWithTransfer('drop', transfer, 1))
    await Promise.resolve()

    expect(onMoveLocal).toHaveBeenCalledWith('lf:moving', 'lf:parent', 'lf:first')
    expect(getState().customOrder).toEqual(['lf:parent', 'lf:moving', 'lf:first'])
  })

  it('disarms an earlier placement when the hovered row refuses the drop', () => {
    const url = 'https://example.com'
    setState({
      servers: [
        {
          url,
          info: { id: 'server-id', name: 'Server', auth: 'none' },
          token: null,
          status: 'connected',
          isAdmin: true,
          season: 0,
        },
      ],
      localFolders: [],
      customOrder: [`server:${url}`, 'local'],
      collapsed: [],
      sort: { field: 'custom', direction: 'asc' },
    })
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
      onMoveLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const tree = treeContents(callbacks, vi.fn())
    const local = tree.querySelector<HTMLElement>('[data-caelestis-key="local"]')
    const server = tree.querySelector<HTMLElement>(`[data-caelestis-key="server:${url}"]`)
    if (local === null || server === null) throw new Error('expected rendered category rows')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'local')

    local.dispatchEvent(eventWithTransfer('dragstart', transfer))
    server.dispatchEvent(eventWithTransfer('dragover', transfer, -1))
    server.dispatchEvent(eventWithTransfer('dragover', transfer, 1))
    server.dispatchEvent(eventWithTransfer('drop', transfer, 1))

    expect(getState().customOrder).toEqual([`server:${url}`, 'local'])
    expect(callbacks.onDropInServer).not.toHaveBeenCalled()
  })

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
