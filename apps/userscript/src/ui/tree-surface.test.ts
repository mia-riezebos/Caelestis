import type { TemplateSurface } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerManifest } from '../server-manifest.js'

const scoped = vi.hoisted(() => ({ manifest: null as ServerManifest | null }))

vi.mock('../alliance-server-sync.js', () => ({
  allianceManifestFor: (_server: unknown, _surface: TemplateSurface) => scoped.manifest,
  refreshAllianceManifest: vi.fn(),
}))

import { nodeTreeKey, serverTemplateTreeKey } from '../application/tree-server-state.js'
import type { ConnectedServer } from '../state.js'
import { setState } from '../state.js'
import { templateTreeAdapter } from './tree.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const TEMPLATE_ID = '019fed50-87a1-7523-a88c-bdeafad49683'
const SOURCE_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49685'
const DESTINATION_NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49686'
const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
const serverInfo = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
const server: ConnectedServer = {
  url: 'https://example.com',
  info: serverInfo,
  token: null,
  status: 'connected',
  isAdmin: true,
  season: 0,
}

const callbacks = {
  onAddServer: vi.fn(),
  onCreateFolder: vi.fn(),
  onImportTemplate: vi.fn(),
  onContextMenu: vi.fn(),
  onCopyToServer: vi.fn(),
  onDropInLocal: vi.fn(async () => null),
  onDropInServer: vi.fn(async () => null),
}

afterEach(() => {
  scoped.manifest = null
  vi.clearAllMocks()
  setState({ servers: [], customOrder: [], collapsed: [], localFolders: [] })
})

describe('surface-scoped template tree', () => {
  it('renders creation actions and only the selected alliance surface', () => {
    scoped.manifest = {
      version: 'alliance-manifest-v1',
      season: 0,
      surface,
      server: serverInfo,
      nodes: [
        {
          id: SOURCE_NODE_ID,
          parentId: null,
          path: '/source',
          name: 'Source',
          createdAt: 1,
        },
        {
          id: DESTINATION_NODE_ID,
          parentId: null,
          path: '/destination',
          name: 'Destination',
          createdAt: 1,
        },
      ],
      templates: [
        {
          id: TEMPLATE_ID,
          nodeId: SOURCE_NODE_ID,
          name: 'HQ guide',
          version: '019fed50-87a1-7523-a88c-bdeafad49684',
          totalPixels: 4,
          published: true,
          finished: false,
          finishedAt: null,
          timelapseFrozen: false,
          updatedAt: 1,
          bbox: { minX: -2, minY: -2, maxX: 0, maxY: 0 },
          chunks: [],
          surface,
        },
      ],
    }
    setState({
      servers: [server],
      collapsed: [],
      localFolders: [
        { id: 'hq', parentId: null, name: 'HQ folder', visible: true, surface },
        {
          id: 'world',
          parentId: null,
          name: 'World folder',
          visible: true,
          surface: { kind: 'world', allianceId: null },
        },
      ],
    })

    const adapter = templateTreeAdapter(callbacks, vi.fn(), '', surface)
    const row = adapter.model.entries.find(
      (entry) => entry.type === 'row' && entry.name === 'HQ guide',
    )

    const local = adapter.model.entries.find(
      (entry) => entry.type === 'row' && entry.key === 'local',
    )
    const serverRoot = adapter.model.entries.find(
      (entry) => entry.type === 'row' && entry.key === `server:${server.url}`,
    )

    expect(row).toMatchObject({
      type: 'row',
      name: 'HQ guide',
      renamable: true,
      contextMenu: true,
      canReparent: true,
      progress: { completed: 0, known: 0, total: 4 },
      leadingActions: [expect.objectContaining({ label: 'Go to' })],
    })
    expect(local).toMatchObject({
      type: 'row',
      actions: [
        expect.objectContaining({ label: 'New folder' }),
        expect.objectContaining({ label: 'Import template' }),
      ],
    })
    expect(serverRoot).toMatchObject({
      type: 'row',
      actions: [
        expect.objectContaining({ label: 'New folder' }),
        expect.objectContaining({ label: 'Import template' }),
      ],
    })
    expect(adapter.model.entries).toContainEqual(
      expect.objectContaining({ type: 'action', key: 'local-import' }),
    )
    expect(adapter.model.entries).not.toContainEqual(
      expect.objectContaining({ type: 'action', key: 'add-server' }),
    )
    expect(adapter.model.entries).toContainEqual(
      expect.objectContaining({ type: 'row', name: 'HQ folder' }),
    )
    expect(adapter.model.entries).not.toContainEqual(
      expect.objectContaining({ type: 'row', name: 'World folder' }),
    )

    adapter.handle({ type: 'action', key: 'local', actionId: 'row-0' })
    adapter.handle({ type: 'action', key: `server:${server.url}`, actionId: 'row-1' })
    adapter.handle({ type: 'action', key: 'local-import', actionId: 'run' })
    adapter.handle({
      type: 'drop',
      draggedKey: serverTemplateTreeKey(server, TEMPLATE_ID),
      targetKey: nodeTreeKey(server, DESTINATION_NODE_ID),
      position: 'inside',
    })

    expect(callbacks.onCreateFolder).toHaveBeenCalledWith(expect.objectContaining({ key: 'local' }))
    expect(callbacks.onImportTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ key: `server:${server.url}` }),
    )
    expect(callbacks.onImportTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'local' }),
    )
    expect(callbacks.onDropInServer).toHaveBeenCalledWith(
      server,
      DESTINATION_NODE_ID,
      serverTemplateTreeKey(server, TEMPLATE_ID),
      null,
    )
  })
})
