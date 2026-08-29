// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptServerSnapshot,
  forgetServerRows,
  nodeTreeKey,
  optimisticallyPlaceServerRow,
  serverTemplateTreeKey,
} from '../application/tree-server-state.js'
import { getState, setState } from '../state.js'
import { startRenaming, type TreeCallbacks, templateTreeAdapter } from './tree.js'

const navigationHarness = vi.hoisted(() => ({ navigateTo: vi.fn() }))
const telemetryHarness = vi.hoisted(() => ({
  progress: new Map<
    string,
    { completed: number; mismatched: number; unpainted: number; known: number; total: number }
  >(),
}))

vi.mock('../templates/navigate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../templates/navigate.js')>()),
  navigateTo: navigationHarness.navigateTo,
}))
vi.mock('../telemetry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../telemetry.js')>()
  return {
    ...original,
    serverProgressFor: (
      server: Parameters<typeof original.serverProgressFor>[0],
      template: Parameters<typeof original.serverProgressFor>[1],
    ) => telemetryHarness.progress.get(template.id) ?? original.serverProgressFor(server, template),
  }
})
vi.mock('../local-folders.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../local-folders.js')>()
  const state = await import('../state.js')
  return {
    ...original,
    moveLocalFolder: (id: string, parentId: string | null) => {
      const folders = state.getState().localFolders
      state.setState({
        localFolders: folders.map((folder) =>
          folder.id === id ? { ...folder, parentId } : folder,
        ),
      })
      return true
    },
    renameLocalFolder: (id: string, name: string) => {
      const folders = state.getState().localFolders
      state.setState({
        localFolders: folders.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      })
      return true
    },
  }
})
vi.mock('./toast.js', () => ({ toast: vi.fn() }))

const SERVER_URL = 'https://server.example.com'
const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const SOURCE_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const DESTINATION_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49683'
const TEMPLATE_A_ID = '019fed50-87a1-7523-a88c-bdeafad49684'
const TEMPLATE_B_ID = '019fed50-87a1-7523-a88c-bdeafad49685'

afterEach(() => {
  telemetryHarness.progress.clear()
  forgetServerRows(SERVER_URL)
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
  totalPixels: 100,
  published: true,
  updatedAt,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  chunks: [],
})

const treeRows = (callbacks: TreeCallbacks, query = '') =>
  templateTreeAdapter(callbacks, vi.fn(), query).model.entries.filter(
    (entry) => entry.type === 'row',
  )

describe('tree drag and drop', () => {
  it('commits a Local folder rename through the tree interface', async () => {
    setState({
      localFolders: [{ id: 'folder', parentId: null, name: 'Before', visible: true }],
    })
    startRenaming('lf:folder')
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }

    const adapter = templateTreeAdapter(callbacks, vi.fn())
    expect(adapter.model.renamingKey).toBe('lf:folder')
    adapter.handle({ type: 'rename', key: 'lf:folder', name: 'After' })
    await Promise.resolve()

    expect(getState().localFolders.find(({ id }) => id === 'folder')?.name).toBe('After')
  })

  it('keeps a fly-to action on server template rows', () => {
    const server = connectedServer()
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [],
      templates: [{ ...serverTemplate(TEMPLATE_A_ID, null, 'Template', 1), published: false }],
    })
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }

    const adapter = templateTreeAdapter(callbacks, vi.fn())
    const key = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    const row = adapter.model.entries.find((entry) => entry.type === 'row' && entry.key === key)
    const flyTo =
      row?.type === 'row'
        ? row.leadingActions?.find((action) => action.label === 'Go to')
        : undefined

    expect(row).toEqual(expect.objectContaining({ muted: true, branches: expect.any(Array) }))
    expect(flyTo).toBeDefined()
    if (flyTo !== undefined) adapter.handle({ type: 'action', key, actionId: flyTo.id })
    expect(navigationHarness.navigateTo).toHaveBeenCalledWith({
      x: 0.5,
      y: 0.5,
      width: 1,
      height: 1,
    })
  })

  it('opens the export menu for server members without edit permission', () => {
    const server = { ...connectedServer(), isAdmin: false }
    setState({
      servers: [server],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [],
      templates: [serverTemplate(TEMPLATE_A_ID, null, 'Template', 1)],
    })
    const onContextMenu = vi.fn()
    const adapter = templateTreeAdapter(
      {
        onAddServer: vi.fn(),
        onCreateFolder: vi.fn(),
        onImportTemplate: vi.fn(),
        onContextMenu,
        onCopyToServer: vi.fn(),
        onDropInLocal: vi.fn(),
        onDropInServer: vi.fn(),
      },
      vi.fn(),
    )
    adapter.handle({
      type: 'context-menu',
      key: serverTemplateTreeKey(server, TEMPLATE_A_ID),
      x: 0,
      y: 0,
    })

    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: TEMPLATE_A_ID }),
      expect.any(MouseEvent),
    )
  })

  it('renders newly discovered server templates newest-first', () => {
    const server = connectedServer()
    setState({
      servers: [server],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [],
      templates: [
        serverTemplate(TEMPLATE_A_ID, null, 'Older', 1),
        serverTemplate(TEMPLATE_B_ID, null, 'Newer', 2),
      ],
    })

    const keys = treeRows({
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    })
      .filter((row) => row.key.startsWith('st:'))
      .map((row) => row.key)

    expect(keys).toEqual([
      serverTemplateTreeKey(server, TEMPLATE_B_ID),
      serverTemplateTreeKey(server, TEMPLATE_A_ID),
    ])
  })

  it('sorts template progress without moving a folder slot', () => {
    const server = connectedServer()
    const folder = serverNode(SOURCE_NODE_ID, 'Folder')
    const done = serverTemplateTreeKey(server, TEMPLATE_A_ID)
    const todo = serverTemplateTreeKey(server, TEMPLATE_B_ID)
    const folderKey = nodeTreeKey(server, SOURCE_NODE_ID)
    telemetryHarness.progress.set(TEMPLATE_A_ID, {
      completed: 90,
      mismatched: 0,
      unpainted: 10,
      known: 100,
      total: 100,
    })
    telemetryHarness.progress.set(TEMPLATE_B_ID, {
      completed: 10,
      mismatched: 0,
      unpainted: 90,
      known: 100,
      total: 100,
    })
    setState({
      servers: [server],
      collapsed: ['local'],
      customOrder: [done, folderKey, todo],
      sort: { field: 'progress', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [folder],
      templates: [
        serverTemplate(TEMPLATE_A_ID, null, 'Done', 1),
        serverTemplate(TEMPLATE_B_ID, null, 'Todo', 2),
      ],
    })

    const keys = treeRows({
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    })
      .map((row) => row.key)
      .filter((key): key is string => key === done || key === todo || key === folderKey)

    expect(keys).toEqual([todo, folderKey, done])
  })

  it('shows descendant progress on folder and server parent rows', () => {
    const server = connectedServer()
    const folder = serverNode(SOURCE_NODE_ID, 'Folder')
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [folder],
      templates: [
        serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'A', 1),
        { ...serverTemplate(TEMPLATE_B_ID, SOURCE_NODE_ID, 'B', 2), totalPixels: 50 },
      ],
    })

    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const rows = treeRows(callbacks)
    const serverRow = rows.find((row) => row.key === `server:${SERVER_URL}`)
    const folderRow = rows.find((row) => row.key === nodeTreeKey(server, SOURCE_NODE_ID))
    const templateRow = rows.find((row) => row.key === serverTemplateTreeKey(server, TEMPLATE_A_ID))

    expect(serverRow?.progress).toEqual(expect.objectContaining({ total: 150, known: 0 }))
    expect(folderRow?.progress).toEqual(expect.objectContaining({ total: 150, known: 0 }))
    expect(serverRow?.branches ?? []).toHaveLength(0)
    expect(folderRow?.branches).toBeDefined()
    expect(templateRow?.branches).toBeDefined()
    expect(folderRow).toEqual(expect.objectContaining({ setSize: 1, positionInSet: 1 }))
    expect(templateRow).toEqual(expect.objectContaining({ setSize: 2, positionInSet: 2 }))
  })

  it('continues the tree branches through an empty folder placeholder', () => {
    const server = connectedServer()
    const emptyFolder = serverNode(SOURCE_NODE_ID, 'Empty folder')
    const populatedFolder = serverNode(DESTINATION_NODE_ID, 'Populated folder')
    setState({
      servers: [server],
      localFolders: [],
      customOrder: [],
      collapsed: ['local'],
      sort: { field: 'custom', direction: 'asc' },
    })
    acceptServerSnapshot(server, {
      nodes: [emptyFolder, populatedFolder],
      templates: [serverTemplate(TEMPLATE_A_ID, DESTINATION_NODE_ID, 'Template', 1)],
    })
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }

    const empty = templateTreeAdapter(callbacks, vi.fn()).model.entries.find(
      (entry) => entry.type === 'notice' && entry.text === 'Empty.',
    )
    expect(empty).toEqual(expect.objectContaining({ branches: expect.arrayContaining([true]) }))
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
    acceptServerSnapshot(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const rowOrder = (): string[] => treeRows(callbacks).map((row) => row.key)

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
    acceptServerSnapshot(server, {
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
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer,
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({ type: 'drop', draggedKey: firstKey, targetKey: secondKey, position: 'after' })
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
    acceptServerSnapshot(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer,
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: templateKey,
      targetKey: nodeTreeKey(server, DESTINATION_NODE_ID),
      position: 'inside',
    })
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
    acceptServerSnapshot(server, {
      nodes: [source, destination],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer,
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: templateKey,
      targetKey: nodeTreeKey(server, DESTINATION_NODE_ID),
      position: 'inside',
    })
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
    acceptServerSnapshot(server, {
      nodes: [source],
      templates: [serverTemplate(TEMPLATE_A_ID, SOURCE_NODE_ID, 'Template', 1)],
    })
    const onDropInServer = vi.fn(async () => templateKey)
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer,
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: templateKey,
      targetKey: `server:${SERVER_URL}`,
      position: 'inside',
    })
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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: 'lf:moving',
      targetKey: 'lf:parent',
      position: 'inside',
    })
    await Promise.resolve()

    expect(getState().localFolders.find(({ id }) => id === 'moving')?.parentId).toBe('parent')
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
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: 'local',
      targetKey: `server:${url}`,
      position: 'inside',
    })

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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn())
    adapter.handle({
      type: 'drop',
      draggedKey: 'lf:moving',
      targetKey: 'lf:destination',
      position: 'inside',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(getState().localFolders.find(({ id }) => id === 'moving')?.parentId).toBe('destination')
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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn(), 'match')
    adapter.handle({ type: 'drop', draggedKey: 'lf:moving', targetKey: 'lf:b', position: 'after' })
    await Promise.resolve()
    await Promise.resolve()

    expect(getState().localFolders.find(({ id }) => id === 'moving')?.parentId).toBe('destination')
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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
      onDropInServer: vi.fn(),
    }
    const adapter = templateTreeAdapter(callbacks, vi.fn(), 'match')
    adapter.handle({
      type: 'drop',
      draggedKey: 'lf:moving',
      targetKey: 'lf:destination',
      position: 'inside',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(getState().localFolders.find(({ id }) => id === 'moving')?.parentId).toBe('destination')
    expect(
      getState().customOrder.filter((key) => ['lf:moving', 'lf:hidden-child'].includes(key)),
    ).toEqual(['lf:moving', 'lf:hidden-child'])
  })
})
