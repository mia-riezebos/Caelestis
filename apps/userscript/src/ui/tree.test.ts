import {
  EMPTY_TEMPLATE_FILTERS,
  parseTemplateFilters,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TREE_NODES } from '../server-manifest.js'

const serverCache = vi.hoisted(() => ({ cacheServer: vi.fn(async () => undefined) }))

vi.mock('../server-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server-cache.js')>()),
  cacheServer: serverCache.cacheServer,
}))

import {
  acceptServerSnapshot,
  forgetServerRows,
  nodeTreeKey,
  refreshServerSnapshot,
  serverTemplateAt,
  serverTemplateTreeKey,
} from '../application/tree-server-state.js'
import {
  admittedServerContentsFor,
  type ConnectedServer,
  getState,
  listServerContents,
  peekProbedNodes,
  probeServer,
  setState,
} from '../state.js'
import { setTemplateDisplayMode } from './display-mode.js'
import { templateTreeAdapter, templateTreeKeyFor } from './tree.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const TEMPLATE_A = '019fed50-87a1-7523-a88c-bdeafad49683'

const manifest = (
  info: { readonly id: string; readonly name: string; readonly auth: 'none' },
  nodes: readonly unknown[] = [],
  templates: readonly unknown[] = [],
  tiles: readonly string[] = [],
): Response =>
  new Response(
    JSON.stringify({ version: 'v1', season: 0, server: info, nodes, templates, tiles }),
    { status: 200 },
  )

afterEach(() => {
  forgetServerRows('https://public.example.com')
  forgetServerRows('https://cached.example.com')
  forgetServerRows('https://loading.example.com')
  setState({ servers: [], customOrder: [], collapsed: [], filters: EMPTY_TEMPLATE_FILTERS })
  serverCache.cacheServer.mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderedText = (adapter: ReturnType<typeof templateTreeAdapter>): string =>
  adapter.model.entries
    .map((entry) =>
      entry.type === 'row' ? entry.name : entry.type === 'notice' ? entry.text : entry.action.label,
    )
    .join(' ')

const callbacks = {
  onAddServer: vi.fn(),
  onCreateFolder: vi.fn(),
  onImportTemplate: vi.fn(),
  onContextMenu: vi.fn(),
  onCopyToServer: vi.fn(),
  onDropInLocal: vi.fn(),
  onDropInServer: vi.fn(),
}

const server = (id: string, season: number, url = 'https://example.com'): ConnectedServer => ({
  url,
  info: { id, name: 'Example', auth: 'none' },
  token: null,
  status: 'connected',
  isAdmin: true,
  season,
})

describe('tree model adapter', () => {
  it('filters tree and grid by current claims, retaining unknown claims outside unclaimed results', () => {
    const connected = server(SERVER_ID, 0, 'https://cached.example.com')
    setState({ servers: [connected] })
    acceptServerSnapshot(connected, {
      nodes: [],
      templates: [
        {
          id: TEMPLATE_A,
          nodeId: null,
          name: 'Claimed art',
          version: 'v1',
          published: true,
          updatedAt: 1,
          bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
          chunks: [],
        },
      ],
    })
    const key = serverTemplateTreeKey(connected, TEMPLATE_A)
    for (const mode of ['tree', 'grid'] as const) {
      setTemplateDisplayMode(mode)
      for (const [choice, mine, claimed, known, expected] of [
        ['mine', true, true, true, true],
        ['mine', false, true, true, false],
        ['claimed', false, true, true, true],
        ['unclaimed', false, false, true, true],
        ['unclaimed', false, false, false, false],
      ] as const) {
        setState({ filters: parseTemplateFilters({ claims: [choice] }) })
        const claims = new Map([
          [
            key,
            {
              mine,
              known,
              people: claimed ? [{ wplaceUserId: 42, displayName: 'Mia' }] : [],
              canAssign: false,
              canClaim: true,
            },
          ],
        ])
        const model = templateTreeAdapter(
          callbacks,
          vi.fn(),
          '',
          WORLD_TEMPLATE_SURFACE,
          false,
          undefined,
          claims,
        ).model
        expect(model.entries.some((entry) => entry.type === 'row' && entry.key === key)).toBe(
          expected,
        )
      }
    }
    setTemplateDisplayMode('tree')
  })
  it('offers server filters only when the current canvas has template data, including cached rows offline', () => {
    const connected = server(SERVER_ID, 0, 'https://cached.example.com')
    for (const status of ['unreachable', 'needs-token'] as const) {
      setState({ servers: [{ ...connected, status }] })
      expect(templateTreeAdapter(callbacks, vi.fn()).model.serverFiltersAvailable).toBe(false)
    }
    setState({ servers: [connected] })
    acceptServerSnapshot(connected, {
      nodes: [],
      templates: [
        {
          id: TEMPLATE_A,
          nodeId: null,
          name: 'Cached',
          version: 'v1',
          published: true,
          finished: true,
          updatedAt: 1,
          bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
          chunks: [],
        },
      ],
    })
    setState({ servers: [{ ...connected, status: 'unreachable' }] })
    expect(templateTreeAdapter(callbacks, vi.fn()).model.serverFiltersAvailable).toBe(true)
    expect(
      templateTreeAdapter(callbacks, vi.fn(), '', {
        kind: 'alliance-headquarters',
        allianceId: 123,
      }).model.serverFiltersAvailable,
    ).toBe(false)
  })
  it('maps focused local and server templates to their rendered row keys', () => {
    const connected = server(SERVER_ID, 0)

    expect(templateTreeKeyFor({ id: 'local-template' }, [])).toBe('local:local-template')
    expect(
      templateTreeKeyFor(
        {
          id: 'drawn-server-template',
          serverUrl: connected.url,
          serverTemplateId: TEMPLATE_A,
        },
        [connected],
      ),
    ).toBe(serverTemplateTreeKey(connected, TEMPLATE_A))
    expect(
      templateTreeKeyFor(
        {
          id: 'orphaned-server-template',
          serverUrl: 'https://disconnected.example.com',
          serverTemplateId: TEMPLATE_A,
        },
        [connected],
      ),
    ).toBeUndefined()
    expect(templateTreeKeyFor(null, [connected])).toBeUndefined()
  })

  it('translates tree state and routes typed expansion and action intents', () => {
    setState({ collapsed: ['local'] })
    const rerender = vi.fn()
    const onImportTemplate = vi.fn()
    const adapter = templateTreeAdapter({ ...callbacks, onImportTemplate }, rerender)

    expect(adapter.model.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'row',
          key: 'local',
          name: 'Local',
          expanded: false,
          positionInSet: 1,
          setSize: 1,
          actions: expect.arrayContaining([
            expect.objectContaining({ label: 'Import template', returnToCanvas: true }),
          ]),
        }),
        expect.objectContaining({ type: 'action', key: 'add-server' }),
      ]),
    )

    adapter.handle({ type: 'toggle-expanded', key: 'local' })
    expect(getState().collapsed).not.toContain('local')
    expect(rerender).toHaveBeenCalled()

    const local = adapter.model.entries.find(
      (entry) => entry.type === 'row' && entry.key === 'local',
    )
    const importAction =
      local?.type === 'row'
        ? local.actions?.find((action) => action.label === 'Import template')
        : undefined
    expect(importAction).toBeDefined()
    adapter.handle({ type: 'action', key: 'local', actionId: importAction?.id ?? '' })
    expect(onImportTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'local', server: null }),
    )
  })
})

describe('tree identity and ordering', () => {
  it('uses the same grouped, searched, and sorted catalog in both display modes', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('GM_getValue', (key: string) => saved.get(key))
    vi.stubGlobal('GM_setValue', (key: string, value: string) => saved.set(key, value))
    const connected = server(SERVER_ID, 0)
    setState({ servers: [connected] })
    const folder = { id: NODE_ID, parentId: null, path: '/art', name: 'Art', createdAt: 1 }
    const template = {
      id: TEMPLATE_A,
      nodeId: NODE_ID,
      name: 'City',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 10, minY: 20, maxX: 40, maxY: 70 },
      chunks: [],
    }
    acceptServerSnapshot(connected, {
      nodes: [folder],
      templates: [template, { ...template, id: 'root-art', nodeId: null, name: 'Root artwork' }],
    })
    for (const query of ['', 'city', 'missing']) {
      for (const field of ['custom', 'name', 'size', 'progress', 'recent', 'mismatched'] as const) {
        setState({ sort: { field, direction: 'asc' } })
        setTemplateDisplayMode('tree')
        const tree = templateTreeAdapter(callbacks, vi.fn(), query).model
        setTemplateDisplayMode('grid')
        const grid = templateTreeAdapter(callbacks, vi.fn(), query).model
        expect(grid).toEqual({ ...tree, displayMode: 'grid' })
      }
    }
    const entries = templateTreeAdapter(callbacks, vi.fn()).model.entries
    expect(entries).toContainEqual(
      expect.objectContaining({
        key: serverTemplateTreeKey(connected, TEMPLATE_A),
        parentKey: nodeTreeKey(connected, NODE_ID),
        preview: { width: 30, height: 50, ownership: 'Server · Example', indices: undefined },
      }),
    )
    setState({ collapsed: [nodeTreeKey(connected, NODE_ID)] })
    const collapsed = templateTreeAdapter(callbacks, vi.fn()).model.entries
    const complete = templateTreeAdapter(
      callbacks,
      vi.fn(),
      '',
      undefined,
      true,
      new Set([serverTemplateTreeKey(connected, TEMPLATE_A)]),
    )
    expect(complete.model.entries).toContainEqual(
      expect.objectContaining({
        key: serverTemplateTreeKey(connected, TEMPLATE_A),
        leadingActions: expect.arrayContaining([expect.objectContaining({ icon: 'search' })]),
      }),
    )
    expect(getState().collapsed).toEqual([nodeTreeKey(connected, NODE_ID)])
    expect(
      complete.model.entries.some(
        (entry) => entry.key === serverTemplateTreeKey(connected, 'root-art'),
      ),
    ).toBe(false)
    expect(
      collapsed.some((entry) => entry.key === serverTemplateTreeKey(connected, TEMPLATE_A)),
    ).toBe(false)
    setTemplateDisplayMode('tree')
    expect(templateTreeAdapter(callbacks, vi.fn()).model.entries).toEqual(collapsed)
    setState({ sort: { field: 'custom', direction: 'asc' } })
  })
  it('replaces tree rows when a manifest arrives outside an explicit refresh', () => {
    const connected = server(SERVER_ID, 0)
    setState({ servers: [connected] })
    const template = {
      id: TEMPLATE_A,
      nodeId: 'folder-a',
      name: 'Template',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [],
    }

    expect(acceptServerSnapshot(connected, { nodes: [], templates: [template] })).toEqual({
      status: 'admitted',
      changed: true,
    })
    expect(serverTemplateAt(connected.url, TEMPLATE_A)?.nodeId).toBe('folder-a')

    expect(
      acceptServerSnapshot(connected, {
        nodes: [],
        templates: [{ ...template, nodeId: 'folder-b' }],
      }),
    ).toEqual({ status: 'admitted', changed: true })
    expect(serverTemplateAt(connected.url, TEMPLATE_A)?.nodeId).toBe('folder-b')

    expect(
      acceptServerSnapshot(connected, {
        nodes: [],
        templates: [{ ...template, nodeId: 'folder-b', bbox: { ...template.bbox }, chunks: [] }],
      }),
    ).toEqual({ status: 'admitted', changed: false })
  })

  it('keeps the last admitted rows when a newer snapshot exceeds client limits', () => {
    const connected = server(SERVER_ID, 0, 'https://limited.example.com')
    setState({ servers: [connected] })
    const template = {
      id: TEMPLATE_A,
      nodeId: null,
      name: 'Kept',
      version: 'v1',
      published: true,
      updatedAt: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [],
    }
    expect(acceptServerSnapshot(connected, { nodes: [], templates: [template] }).status).toBe(
      'admitted',
    )

    const node = {
      id: NODE_ID,
      parentId: null,
      path: '/too-many',
      name: 'Too many',
      createdAt: 1,
    }
    expect(
      acceptServerSnapshot(connected, {
        nodes: new Array(MAX_TREE_NODES + 1).fill(node),
        templates: [],
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'refused',
        message: expect.stringContaining('client limit'),
      }),
    )
    expect(serverTemplateAt(connected.url, TEMPLATE_A)?.name).toBe('Kept')
    forgetServerRows(connected.url)
  })

  it('reports a snapshot from a replaced connection as superseded', () => {
    const original = server(SERVER_ID, 0, 'https://superseded.example.com')
    setState({ servers: [{ ...original, token: 'replacement' }] })

    expect(acceptServerSnapshot(original, { nodes: [], templates: [] })).toEqual(
      expect.objectContaining({ status: 'superseded' }),
    )
  })

  it('publishes one admitted snapshot for coalesced tree and canvas reads', async () => {
    const releases: Array<(response: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releases.push(resolve)
          }),
      ),
    )
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    const connected = server(SERVER_ID, 0, 'https://ordered.example.com')
    setState({ servers: [connected] })
    const template = {
      id: TEMPLATE_A,
      nodeId: null,
      name: 'Newer',
      version: '019fed50-87a1-7523-a88c-bdeafad49684',
      published: true,
      createdAt: 1_750_000_000_000,
      updatedAt: 1_750_000_000_002,
      totalPixels: 1,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
    }

    const first = listServerContents(connected)
    const second = listServerContents(connected)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    releases[0]?.(manifest(info, [], [template], ['0/0']))
    const [firstContents, secondContents] = await Promise.all([first, second])
    expect(firstContents).not.toBeNull()
    expect(secondContents).toBe(firstContents)
    expect(admittedServerContentsFor(connected)).toBe(firstContents)
    expect(serverCache.cacheServer).toHaveBeenCalledOnce()
    expect(serverTemplateAt(connected.url, TEMPLATE_A)?.name).toBe('Newer')
    forgetServerRows(connected.url)
  })

  it('namespaces node UI state by verified server identity and season', () => {
    const first = nodeTreeKey(server(SERVER_ID, 0), NODE_ID)
    const otherServer = nodeTreeKey(server('019fed50-87a1-7523-a88c-bdeafad49683', 0), NODE_ID)
    const nextSeason = nodeTreeKey(server(SERVER_ID, 1), NODE_ID)

    expect(new Set([first, otherServer, nextSeason])).toHaveLength(3)
  })

  it('namespaces node UI state by canonical connection URL too', () => {
    const first = nodeTreeKey(server(SERVER_ID, 0, 'https://example.com'), NODE_ID)
    const alias = nodeTreeKey(server(SERVER_ID, 0, 'https://example.com/api'), NODE_ID)

    expect(first).not.toBe(alias)
  })

  it('notifies every view waiting on one in-flight node refresh', async () => {
    let release: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    const connected = server(SERVER_ID, 0)
    setState({ servers: [connected] })
    const firstView = vi.fn()
    const rebuiltView = vi.fn()

    const first = refreshServerSnapshot(connected, firstView)
    const rebuilt = refreshServerSnapshot(connected, rebuiltView)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledOnce()
    release?.(manifest({ id: SERVER_ID, name: 'Example', auth: 'none' }))
    await Promise.all([first, rebuilt])
    await Promise.resolve()

    expect(firstView).toHaveBeenCalledOnce()
    expect(rebuiltView).toHaveBeenCalledOnce()
  })

  it('defers the rerender while refreshing the public manifest', async () => {
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes: [],
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('[]', { status: 200 }))
        .mockResolvedValueOnce(manifest(info)),
    )
    const connected = await probeServer('https://example.com', null)
    setState({ servers: [connected] })
    const rerender = vi.fn()

    const refreshing = refreshServerSnapshot(connected, rerender)
    expect(rerender).not.toHaveBeenCalled()
    await refreshing
    await Promise.resolve()

    expect(rerender).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('bypasses the connect-time probe snapshot for a forced admin refresh', async () => {
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes: [],
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(manifest(info)),
    )
    const connected = await probeServer('https://example.com', null)
    setState({ servers: [connected] })

    await expect(refreshServerSnapshot(connected, vi.fn(), true)).resolves.toEqual(
      expect.objectContaining({ status: 'admitted' }),
    )

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch).toHaveBeenLastCalledWith(
      'https://example.com/backend/v1/manifest?season=0',
      expect.any(Object),
    )
    expect(peekProbedNodes(connected)).toBeUndefined()
  })

  it('retains the probe snapshot when a forced live refresh fails', async () => {
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    const nodes = [
      {
        id: NODE_ID,
        parentId: null,
        path: '/known',
        name: 'Known',
        createdAt: 1_750_000_000_000,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes,
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 })),
    )
    const connected = await probeServer('https://example.com', null)
    setState({ servers: [connected] })

    await expect(refreshServerSnapshot(connected, vi.fn(), true)).resolves.toEqual(
      expect.objectContaining({ status: 'failed' }),
    )

    expect(peekProbedNodes(connected)).toEqual(nodes)
  })

  it('transfers the probe snapshot when a forced refresh discovers revoked admin scope', async () => {
    const info = { id: SERVER_ID, name: 'Example', auth: 'none' as const }
    const nodes = [
      {
        id: NODE_ID,
        parentId: null,
        path: '/known',
        name: 'Known',
        createdAt: 1_750_000_000_000,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes,
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(manifest(info, nodes)),
    )
    const connected = await probeServer('https://example.com', null)
    setState({ servers: [connected] })

    await refreshServerSnapshot(connected, vi.fn(), true)
    const downgraded = getState().servers[0]

    expect(downgraded).toEqual(expect.objectContaining({ isAdmin: false }))
    expect(downgraded === undefined ? undefined : peekProbedNodes(downgraded)).toEqual(nodes)
  })

  it('retains manifest folders for a connected server without admin scope', async () => {
    const info = { id: SERVER_ID, name: 'Public', auth: 'none' as const }
    const nodes = [
      {
        id: NODE_ID,
        parentId: null,
        path: '/public',
        name: 'Public',
        createdAt: 1_750_000_000_000,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(info), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 'v1',
              season: 0,
              server: info,
              nodes,
              templates: [],
              tiles: [],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(manifest(info, nodes)),
    )
    const connected = await probeServer('https://public.example.com', null)
    setState({ servers: [connected] })

    await expect(refreshServerSnapshot(connected, vi.fn())).resolves.toEqual(
      expect.objectContaining({ status: 'admitted' }),
    )
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('renders cached folders alongside an unreachable connection warning', async () => {
    const connected = server(SERVER_ID, 0, 'https://cached.example.com')
    setState({ servers: [connected] })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          manifest({ id: SERVER_ID, name: 'Example', auth: 'none' }, [
            {
              id: NODE_ID,
              parentId: null,
              path: '/cached',
              name: 'Cached folder',
              createdAt: 1_750_000_000_000,
            },
          ]),
        ),
      ),
    )
    await refreshServerSnapshot(connected, vi.fn())
    const stale: ConnectedServer = {
      ...connected,
      info: null,
      status: 'unreachable',
      error: 'offline',
      isAdmin: false,
      season: null,
      lastVerified: { serverId: SERVER_ID, season: 0 },
    }
    setState({ servers: [stale] })

    const text = renderedText(templateTreeAdapter(callbacks, vi.fn()))

    expect(text).toContain('Cached folder')
    expect(text).toContain('Could not be reached. offline')
  })

  it('reports loading rather than an empty server while the first folder fetch is pending', () => {
    const connected = server(SERVER_ID, 0, 'https://loading.example.com')
    setState({ servers: [connected] })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )

    const text = renderedText(templateTreeAdapter(callbacks, vi.fn()))

    expect(text).toContain('Loading folders…')
    expect(text).not.toContain('No templates published yet.')
  })
})
