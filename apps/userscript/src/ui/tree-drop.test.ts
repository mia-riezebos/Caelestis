// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getState, setState } from '../state.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { startRenaming, type TreeCallbacks, treeContents } from './tree.js'
import {
  acceptServerSnapshot,
  forgetServerRows,
  nodeTreeKey,
  optimisticallyPlaceServerRow,
  serverTemplateTreeKey,
} from './tree-server-state.js'

const localTemplateHarness = vi.hoisted(() => ({
  templates: vi.fn(() => [] as PlacedTemplate[]),
}))
const navigationHarness = vi.hoisted(() => ({ navigateTo: vi.fn() }))
const telemetryHarness = vi.hoisted(() => ({
  progress: new Map<
    string,
    { completed: number; mismatched: number; unpainted: number; known: number; total: number }
  >(),
}))

vi.mock('../templates/local-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../templates/local-store.js')>()),
  localTemplates: localTemplateHarness.templates,
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

const eventWithTransfer = (type: string, dataTransfer: DataTransfer, clientY = 0): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

afterEach(() => {
  localTemplateHarness.templates.mockReturnValue([])
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

const placedTemplate = (): PlacedTemplate => ({
  id: 'progress-template',
  name: 'Progress template',
  source: 'image',
  originX: 0,
  originY: 0,
  width: 2,
  height: 1,
  indices: new Uint8Array([0, 4]),
  moved: 0,
  opaque: 2,
  tiles: new Map(),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 1,
  owns: [],
  folderId: null,
})

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

    const tree = treeContents(callbacks, vi.fn())
    const input = tree.querySelector<HTMLInputElement>('[data-caelestis-rename]')
    const save = tree.querySelector<HTMLButtonElement>('[aria-label="Save"]')
    if (input === null || save === null) throw new Error('expected the inline rename controls')
    input.value = 'After'
    save.click()
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

    const tree = treeContents(callbacks, vi.fn())
    const row = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
    )
    const flyTo = row?.querySelector<HTMLButtonElement>('[aria-label="Go to"]')

    expect(flyTo).not.toBeNull()
    expect(
      [...(row?.children ?? [])].some(
        (child) => child instanceof HTMLElement && child.style.width === '1rem',
      ),
    ).toBe(false)
    const connector = row?.querySelector<SVGSVGElement>(':scope > .caelestis-tree-connector')
    expect(connector).not.toBeNull()
    expect(connector?.querySelectorAll('line')).toHaveLength(2)
    expect(row?.style.marginInline).toBe('0.25rem 0.5rem')
    expect(flyTo?.parentElement?.classList.contains('caelestis-leading-actions')).toBe(true)
    expect(row?.classList.contains('caelestis-row--expanded-progress')).toBe(false)
    expect(row?.querySelector('[aria-label="Expand progress"]')).not.toBeNull()
    expect(row?.textContent).not.toContain('unpublished')
    expect(row?.classList.contains('caelestis-muted')).toBe(true)
    expect(flyTo?.classList.contains('caelestis-row-action')).toBe(true)
    flyTo?.click()
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
    const tree = treeContents(
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
    const row = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
    )

    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

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

    const keys = [
      ...treeContents(
        {
          onAddServer: vi.fn(),
          onCreateFolder: vi.fn(),
          onImportTemplate: vi.fn(),
          onContextMenu: vi.fn(),
          onCopyToServer: vi.fn(),
          onDropInLocal: vi.fn(),
          onDropInServer: vi.fn(),
        },
        vi.fn(),
      ).querySelectorAll<HTMLElement>('[data-caelestis-key^="st:"]'),
    ].map((row) => row.dataset.caelestisKey)

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

    const keys = [
      ...treeContents(
        {
          onAddServer: vi.fn(),
          onCreateFolder: vi.fn(),
          onImportTemplate: vi.fn(),
          onContextMenu: vi.fn(),
          onCopyToServer: vi.fn(),
          onDropInLocal: vi.fn(),
          onDropInServer: vi.fn(),
        },
        vi.fn(),
      ).querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ]
      .map((row) => row.dataset.caelestisKey)
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
    const render = () => treeContents(callbacks, vi.fn())
    let tree = render()
    const serverRow = tree.querySelector<HTMLElement>(`[data-caelestis-key="server:${SERVER_URL}"]`)
    const folderRow = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`,
    )
    const templateRow = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
    )

    expect(serverRow?.querySelector('.caelestis-progress')?.getAttribute('aria-label')).toContain(
      '0 of 150 pixels scanned',
    )
    expect(folderRow?.querySelector('.caelestis-progress')?.getAttribute('aria-label')).toContain(
      '0 of 150 pixels scanned',
    )
    expect(serverRow?.querySelector(':scope > .caelestis-tree-connector')).toBeNull()
    expect(folderRow?.querySelector(':scope > .caelestis-tree-connector')).not.toBeNull()
    expect(templateRow?.querySelector(':scope > .caelestis-tree-connector')).not.toBeNull()
    expect(serverRow?.style.marginInline).toBe('0.25rem 0.5rem')
    expect(folderRow?.style.marginInline).toBe(serverRow?.style.marginInline)
    expect(folderRow?.getAttribute('aria-setsize')).toBe('1')
    expect(folderRow?.getAttribute('aria-posinset')).toBe('1')
    expect(templateRow?.getAttribute('aria-setsize')).toBe('2')
    expect(templateRow?.getAttribute('aria-posinset')).toBe('2')
    expect(templateRow?.style.marginInline).toBe(serverRow?.style.marginInline)
    for (const row of [serverRow, folderRow]) {
      const tail = row?.querySelector('.caelestis-row-tail')
      expect(tail?.querySelector(':scope > .caelestis-progress--inline')).not.toBeNull()
      expect(tail?.querySelector(':scope > .caelestis-actions')).not.toBeNull()
    }

    folderRow?.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')?.click()
    tree = render()
    expect(
      tree
        .querySelector(`[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`)
        ?.classList.contains('caelestis-row--expanded-progress'),
    ).toBe(true)
    const folderDetail = tree
      .querySelector(`[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`)
      ?.querySelector<HTMLElement>('.caelestis-progress--expanded')
    expect(folderDetail?.style.marginInlineStart).toBe('20px')
    expect(folderDetail?.style.width).toBe('calc(100% - 20px)')

    tree
      .querySelector<HTMLElement>(
        `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
      )
      ?.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')
      ?.click()
    tree = render()
    const templateDetail = tree
      .querySelector(`[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`)
      ?.querySelector<HTMLElement>('.caelestis-progress--expanded')
    expect(templateDetail?.style.marginInlineStart).toBe('')
    tree
      .querySelector<HTMLElement>(
        `[data-caelestis-key="${serverTemplateTreeKey(server, TEMPLATE_A_ID)}"]`,
      )
      ?.querySelector<HTMLButtonElement>('[aria-label="Collapse progress"]')
      ?.click()

    setState({ collapsed: ['local', nodeTreeKey(server, SOURCE_NODE_ID)] })
    tree = render()
    const collapsedFolder = tree.querySelector<HTMLElement>(
      `[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`,
    )
    expect(collapsedFolder?.classList.contains('caelestis-row--expanded-progress')).toBe(false)
    const reopenProgress = collapsedFolder?.querySelector<HTMLButtonElement>(
      '[aria-label="Expand progress"]',
    )
    expect(reopenProgress).not.toBeNull()
    reopenProgress?.click()

    // The progress action opens its parent as required, then return disclosure to the default.
    tree = render()
    expect(
      tree
        .querySelector(`[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`)
        ?.classList.contains('caelestis-row--expanded-progress'),
    ).toBe(true)
    tree
      .querySelector<HTMLElement>(`[data-caelestis-key="${nodeTreeKey(server, SOURCE_NODE_ID)}"]`)
      ?.querySelector<HTMLButtonElement>('[aria-label="Collapse progress"]')
      ?.click()
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

    const tree = treeContents(callbacks, vi.fn())
    const placeholder = [...tree.querySelectorAll<HTMLElement>('[aria-disabled="true"]')].find(
      (row) => row.textContent === 'Empty.',
    )
    const connector = placeholder?.querySelector<SVGSVGElement>(
      ':scope > .caelestis-tree-connector',
    )

    expect(connector).not.toBeNull()
    expect(connector?.querySelectorAll('line')).toHaveLength(3)
    expect(connector?.querySelector('line')?.getAttribute('y2')).toBe('100%')
  })

  it('keeps colour disclosure beside the expanded meter instead of the row actions', () => {
    localTemplateHarness.templates.mockReturnValue([placedTemplate()])
    setState({
      servers: [],
      localFolders: [],
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
    const render = () => treeContents(callbacks, vi.fn())
    let tree = render()
    tree
      .querySelector<HTMLElement>('[data-caelestis-key="local:progress-template"]')
      ?.querySelector<HTMLButtonElement>('[aria-label="Expand progress"]')
      ?.click()

    tree = render()
    let row = tree.querySelector<HTMLElement>('[data-caelestis-key="local:progress-template"]')
    const collapse = row?.querySelector<HTMLButtonElement>('[aria-label="Collapse progress"]')
    const showColours = row?.querySelector<HTMLButtonElement>('[aria-label="Show colour progress"]')

    expect(collapse?.parentElement?.classList.contains('caelestis-actions')).toBe(true)
    expect(
      showColours?.parentElement?.classList.contains('caelestis-progress-detail-actions'),
    ).toBe(true)
    expect(showColours?.parentElement?.classList.contains('caelestis-actions')).toBe(false)
    expect(collapse?.parentElement).not.toBe(showColours?.parentElement)
    expect(showColours?.closest('.caelestis-progress-disclosure')).not.toBeNull()
    expect(
      row?.querySelector('.caelestis-progress-disclosure > .caelestis-progress--expanded'),
    ).not.toBeNull()

    showColours?.click()
    tree = render()
    row = tree.querySelector<HTMLElement>('[data-caelestis-key="local:progress-template"]')
    expect(
      row
        ?.querySelector('[aria-label="Hide colour progress"]')
        ?.closest('.caelestis-progress-disclosure'),
    ).not.toBeNull()
    expect(row?.querySelector('.caelestis-progress-colours')).not.toBeNull()
    row?.querySelector<HTMLButtonElement>('[aria-label="Collapse progress"]')?.click()
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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
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
    const callbacks: TreeCallbacks = {
      onAddServer: vi.fn(),
      onCreateFolder: vi.fn(),
      onImportTemplate: vi.fn(),
      onContextMenu: vi.fn(),
      onCopyToServer: vi.fn(),
      onDropInLocal: vi.fn(),
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

    expect(getState().localFolders.find(({ id }) => id === 'moving')?.parentId).toBe('destination')
    expect(
      getState().customOrder.filter((key) => ['lf:moving', 'lf:hidden-child'].includes(key)),
    ).toEqual(['lf:moving', 'lf:hidden-child'])
  })
})
