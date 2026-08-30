import type { TemplateSurface } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerManifest } from '../server-manifest.js'

const scoped = vi.hoisted(() => ({ manifest: null as ServerManifest | null }))

vi.mock('../alliance-server-sync.js', () => ({
  allianceManifestFor: (_serverUrl: string, _surface: TemplateSurface) => scoped.manifest,
}))

import type { ConnectedServer } from '../state.js'
import { setState } from '../state.js'
import { templateTreeAdapter } from './tree.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const TEMPLATE_ID = '019fed50-87a1-7523-a88c-bdeafad49683'
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
  onDropInLocal: vi.fn(),
  onDropInServer: vi.fn(),
}

afterEach(() => {
  scoped.manifest = null
  setState({ servers: [], customOrder: [], collapsed: [] })
})

describe('surface-scoped template tree', () => {
  it('renders the selected alliance manifest without world navigation or editing actions', () => {
    scoped.manifest = {
      version: 'alliance-manifest-v1',
      season: 0,
      surface,
      server: serverInfo,
      nodes: [],
      templates: [
        {
          id: TEMPLATE_ID,
          nodeId: null,
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
    setState({ servers: [server], collapsed: [] })

    const adapter = templateTreeAdapter(callbacks, vi.fn(), '', surface)
    const row = adapter.model.entries.find(
      (entry) => entry.type === 'row' && entry.name === 'HQ guide',
    )

    expect(row).toMatchObject({ type: 'row', name: 'HQ guide' })
    expect(row).not.toHaveProperty('contextMenu')
    expect(row).not.toHaveProperty('leadingActions')
    expect(adapter.model.entries).not.toContainEqual(
      expect.objectContaining({ type: 'action', key: 'local-import' }),
    )
  })
})
