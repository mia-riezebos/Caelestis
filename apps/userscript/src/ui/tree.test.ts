import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TREE_NODES } from '../server-manifest.js'
import { type ConnectedServer, getState, peekProbedNodes, probeServer, setState } from '../state.js'
import {
  acceptServerSnapshot,
  forgetServerRows,
  nodeTreeKey,
  refreshServerSnapshot,
  serverTemplateAt,
  treeContents,
} from './tree.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const TEMPLATE_A = '019fed50-87a1-7523-a88c-bdeafad49683'

const manifest = (
  info: { readonly id: string; readonly name: string; readonly auth: 'none' },
  nodes: readonly unknown[] = [],
): Response =>
  new Response(
    JSON.stringify({ version: 'v1', season: 0, server: info, nodes, templates: [], tiles: [] }),
    { status: 200 },
  )

afterEach(() => {
  forgetServerRows('https://public.example.com')
  forgetServerRows('https://cached.example.com')
  forgetServerRows('https://loading.example.com')
  setState({ servers: [], customOrder: [], collapsed: [] })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

class FakeElement {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  readonly classList = {
    add: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
  }
  className = ''
  textContent = ''
  checked = false
  disabled = false
  draggable = false
  tabIndex = 0
  title = ''
  type = ''
  value = ''
  scrollWidth = 0
  clientWidth = 0

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children)
  }

  setAttribute(): void {}
  addEventListener(): void {}
  focus(): void {}
  remove(): void {}
  contains(child: FakeElement): boolean {
    return child === this || this.children.some((candidate) => candidate.contains(child))
  }
  querySelector(): FakeElement | null {
    return null
  }
  querySelectorAll(): FakeElement[] {
    return []
  }
}

const installFakeDom = (): void => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('document', {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  })
}

const renderedText = (element: FakeElement): string =>
  [element.textContent, ...element.children.map((child) => renderedText(child))]
    .filter((text) => text !== '')
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

describe('tree identity and ordering', () => {
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
      'https://example.com/backend/manifest?season=0',
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
    installFakeDom()
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

    const tree = treeContents(callbacks, vi.fn()) as unknown as FakeElement
    const text = renderedText(tree)

    expect(text).toContain('Cached folder')
    expect(text).toContain('Could not be reached. offline')
  })

  it('reports loading rather than an empty server while the first folder fetch is pending', () => {
    installFakeDom()
    const connected = server(SERVER_ID, 0, 'https://loading.example.com')
    setState({ servers: [connected] })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )

    const tree = treeContents(callbacks, vi.fn()) as unknown as FakeElement
    const text = renderedText(tree)

    expect(text).toContain('Loading folders…')
    expect(text).not.toContain('No templates published yet.')
  })
})
