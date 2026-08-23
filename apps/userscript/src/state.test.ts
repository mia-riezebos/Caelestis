import { WORLD_PIXELS } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_A = '019fed50-87a1-7523-a88c-bdeafad49682'
const TEMPLATE_A = '019fed50-87a1-7523-a88c-bdeafad49683'

const serverInfo = { id: SERVER_ID, name: 'Caelestis', auth: 'none' as const }
const manifest = {
  version: '3b7f6148884517e03bb2807e18116677',
  season: 0,
  server: serverInfo,
  nodes: [],
  templates: [],
  tiles: [],
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('server state boundaries', () => {
  it('canonicalises equivalent URLs to one stable connection identity', async () => {
    const { canonicalServerUrl } = await import('./state.js')

    expect(canonicalServerUrl(' HTTPS://Example.COM:443/api///?token=leak#fragment ')).toBe(
      'https://example.com/api',
    )
    expect(() => canonicalServerUrl('javascript:alert(1)')).toThrow(/HTTP or HTTPS/)
    expect(() => canonicalServerUrl('https://name:secret@example.com')).toThrow(/credentials/)
  })

  it('does not trust persisted connectivity or scope but retains cache identity', async () => {
    const persist = vi.fn()
    vi.stubGlobal('GM_setValue', persist)
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() =>
        JSON.stringify({
          servers: [
            {
              url: 'https://example.com/',
              info: serverInfo,
              token: 'read-code',
              status: 'connected',
              isAdmin: true,
              season: 99,
            },
          ],
          customOrder: [`node:${NODE_A}`, 'local:kept'],
          collapsed: ['local', 'server:https://example.com'],
          hiddenScopes: [`srv:https://example.com:${TEMPLATE_A}`],
        }),
      ),
    )
    const { loadState } = await import('./state.js')

    expect(loadState().servers).toEqual([
      expect.objectContaining({
        url: 'https://example.com',
        status: 'unreachable',
        isAdmin: false,
        season: null,
        lastVerified: { serverId: SERVER_ID, season: 99 },
      }),
    ])
    expect(loadState().customOrder).toEqual(['local:kept'])
    expect(loadState().collapsed).toEqual(['local', 'server:https://example.com'])
    expect(loadState().hiddenScopes).toEqual([
      `srv:${encodeURIComponent('https://example.com')}:${TEMPLATE_A}`,
    ])
    expect(JSON.parse(String(persist.mock.calls[0]?.[1])).hiddenScopes).toEqual([
      `srv:${encodeURIComponent('https://example.com')}:${TEMPLATE_A}`,
    ])
  })

  it('notifies paint subscribers after restoring persisted order', async () => {
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() => JSON.stringify({ customOrder: ['local:second', 'local:first'] })),
    )
    const { loadState, onStateChange } = await import('./state.js')
    const changed = vi.fn()
    onStateChange(changed)

    loadState()

    expect(changed).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ customOrder: ['local:second', 'local:first'] }),
    )
  })

  it('restores bounded browser-owned preferences for server overlays', async () => {
    const id = `srv:${encodeURIComponent('https://example.com')}:${TEMPLATE_A}`
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() =>
        JSON.stringify({
          serverTemplatePreferences: [
            {
              id,
              appearance: {
                size: 1,
                radius: 0,
                translateX: 0,
                translateY: 0,
                rotation: 0,
                opacity: 0.25,
                hiddenColours: [],
                markMismatch: false,
                markUnpainted: false,
                unpaintedLimit: 0.05,
                markerColour: '#ffffff',
                markerSize: 6,
                dimOthers: false,
                otherOpacity: 0.25,
                otherColour: null,
              },
              owns: ['pixels'],
            },
          ],
        }),
      ),
    )
    const { loadState, serverTemplatePreference } = await import('./state.js')

    loadState()

    expect(serverTemplatePreference(id)).toMatchObject({
      appearance: { opacity: 0.25 },
      owns: ['pixels'],
    })
  })

  it('does not accept a server preference when durable storage refuses it', async () => {
    vi.stubGlobal(
      'GM_setValue',
      vi.fn(() => {
        throw new Error('quota exceeded')
      }),
    )
    const { getState, setServerTemplatePreference } = await import('./state.js')
    const id = `srv:${encodeURIComponent('https://example.com')}:${TEMPLATE_A}`

    expect(setServerTemplatePreference(id, null, ['pixels'])).toBe(false)
    expect(getState().serverTemplatePreferences).toEqual([])
  })

  it('does not accept a visibility scope when durable storage refuses it', async () => {
    vi.stubGlobal(
      'GM_setValue',
      vi.fn(() => {
        throw new Error('quota exceeded')
      }),
    )
    const { getState, setScopeVisible } = await import('./state.js')

    expect(setScopeVisible('server:https://example.com', false)).toBe(false)
    expect(getState().hiddenScopes).toEqual([])
  })

  it('bounds persisted and newly connected servers', async () => {
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() =>
        JSON.stringify({
          servers: Array.from({ length: 40 }, (_, index) => ({
            url: `https://server-${index}.example.com`,
          })),
        }),
      ),
    )
    const { getState, loadState, MAX_CONNECTED_SERVERS, upsertServer } = await import('./state.js')

    expect(loadState().servers).toHaveLength(MAX_CONNECTED_SERVERS)
    expect(
      upsertServer({
        url: 'https://overflow.example.com',
        info: null,
        token: null,
        status: 'unreachable',
        isAdmin: false,
        season: null,
      }),
    ).toBe(false)
    expect(getState().servers).toHaveLength(MAX_CONNECTED_SERVERS)

    const first = getState().servers[0]
    expect(first).toBeDefined()
    if (first === undefined) throw new Error('expected a stored server')
    expect(upsertServer({ ...first, error: 'updated' })).toBe(true)
    expect(getState().servers[0]?.error).toBe('updated')
  })

  it('accepts season zero and uses the validated manifest season for admin probes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { probeServer, takeProbedNodes } = await import('./state.js')

    const connected = await probeServer('https://example.com/', null)
    expect(connected).toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        status: 'connected',
        season: 0,
        isAdmin: true,
      }),
    )
    expect(takeProbedNodes(connected)).toEqual([])
    expect(takeProbedNodes(connected)).toBeUndefined()
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://example.com/admin/nodes?season=0')
  })

  it('accepts chunks on both runs of an antimeridian-wrapped template', async () => {
    const node = {
      id: NODE_A,
      parentId: null,
      path: '/root',
      name: 'Root',
      createdAt: 1_800_000_000_000,
    }
    const wrappedManifest = {
      ...manifest,
      nodes: [node],
      templates: [
        {
          id: '019fed50-87a1-7523-a88c-bdeafad49683',
          nodeId: NODE_A,
          name: 'Across the seam',
          version: '019fed50-87a1-7523-a88c-bdeafad49684',
          bbox: { minX: WORLD_PIXELS - 1, minY: 0, maxX: 1, maxY: 1 },
          totalPixels: 2,
          chunks: [
            { tile: '2047/0', hash: 'a'.repeat(64) },
            { tile: '0/0', hash: 'b'.repeat(64) },
          ],
          published: true,
          createdAt: 1_800_000_000_000,
        },
      ],
      tiles: ['0/0', '2047/0'],
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(wrappedManifest), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [node] }), { status: 200 })),
    )
    const { probeServer } = await import('./state.js')

    await expect(probeServer('https://example.com', null)).resolves.toEqual(
      expect.objectContaining({ status: 'connected', season: 0 }),
    )
  })

  it('rejects a present non-finite template update timestamp', async () => {
    const node = {
      id: NODE_A,
      parentId: null,
      path: '/root',
      name: 'Root',
      createdAt: 1_800_000_000_000,
    }
    const invalidManifest = {
      ...manifest,
      nodes: [node],
      templates: [
        {
          id: TEMPLATE_A,
          nodeId: NODE_A,
          name: 'Invalid date',
          version: '019fed50-87a1-7523-a88c-bdeafad49684',
          bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
          totalPixels: 1,
          chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
          published: true,
          createdAt: 1_800_000_000_000,
          updatedAt: 0,
        },
      ],
      tiles: ['0/0'],
    }
    const body = JSON.stringify(invalidManifest).replace('"updatedAt":0', '"updatedAt":1e309')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    )
    const { listServerContents } = await import('./state.js')

    await expect(
      listServerContents({
        url: 'https://example.com',
        info: serverInfo,
        token: null,
        status: 'connected',
        isAdmin: false,
        season: 0,
        lastVerified: { serverId: SERVER_ID, season: 0 },
      }),
    ).resolves.toBeNull()
  })

  it('refuses local folder writes that the next load would discard', async () => {
    vi.stubGlobal('GM_setValue', vi.fn())
    const { createLocalFolder, MAX_LOCAL_FOLDERS, renameLocalFolder, setState } = await import(
      './state.js'
    )
    setState({
      localFolders: Array.from({ length: MAX_LOCAL_FOLDERS }, (_, index) => ({
        id: `folder-${index}`,
        parentId: null,
        name: `Folder ${index}`,
        visible: true,
      })),
    })

    expect(createLocalFolder(null, 'Overflow')).toBeNull()
    expect(renameLocalFolder('folder-0', 'x'.repeat(257))).toBe(false)
  })

  it('does not retain cached identity after a different server answers at the same URL', async () => {
    const replacementInfo = {
      id: '019fed50-87a1-7523-a88c-bdeafad49699',
      name: 'Replacement',
      auth: 'none' as const,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(replacementInfo), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...manifest, server: replacementInfo, nodes: [null] }), {
            status: 200,
          }),
        ),
    )
    const { getState, probeServer, setState, upsertServer } = await import('./state.js')
    setState({
      servers: [
        {
          url: 'https://example.com',
          info: serverInfo,
          token: null,
          status: 'unreachable',
          isAdmin: false,
          season: null,
          lastVerified: { serverId: SERVER_ID, season: 0 },
        },
      ],
    })

    const replacement = await probeServer('https://example.com', null)
    upsertServer(replacement)

    expect(getState().servers[0]).toEqual(
      expect.objectContaining({ info: replacementInfo, status: 'unreachable' }),
    )
    expect(getState().servers[0]).not.toHaveProperty('lastVerified')
  })

  it('isolates throwing state observers after committing the update', async () => {
    const { getState, onStateChange, setState } = await import('./state.js')
    const reached = vi.fn()
    onStateChange(() => {
      throw new Error('broken observer')
    })
    onStateChange(reached)

    expect(() => setState({ shareTiles: true })).not.toThrow()

    expect(getState().shareTiles).toBe(true)
    expect(reached).toHaveBeenCalledOnce()
  })

  it('does not resurrect a server removed while its refresh is in flight', async () => {
    let releaseServer: ((response: Response) => void) | undefined
    const serverResponse = new Promise<Response>((resolve) => {
      releaseServer = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(serverResponse)
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), { status: 200 })),
    )
    const { refreshStoredServers, removeServer, setState, getState } = await import('./state.js')
    setState({
      servers: [
        {
          url: 'https://example.com',
          info: serverInfo,
          token: null,
          status: 'unreachable',
          isAdmin: false,
          season: null,
        },
      ],
    })

    const refreshing = refreshStoredServers()
    removeServer('https://example.com')
    releaseServer?.(new Response(JSON.stringify(serverInfo), { status: 200 }))
    await refreshing

    expect(getState().servers).toEqual([])
  })

  it('retains a stored access code when automatic refresh receives 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...serverInfo, auth: 'access_token' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    )
    const { getState, refreshStoredServers, setState } = await import('./state.js')
    setState({
      servers: [
        {
          url: 'https://example.com',
          info: { ...serverInfo, auth: 'access_token' },
          token: 'keep-me',
          status: 'connected',
          isAdmin: true,
          season: 0,
        },
      ],
    })

    await refreshStoredServers()

    expect(getState().servers[0]).toEqual(
      expect.objectContaining({ token: 'keep-me', status: 'needs-token' }),
    )
  })

  it('retries an open server anonymously when its persisted token is stale', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const { probeServer } = await import('./state.js')

    await expect(probeServer('https://example.com', 'stale-code')).resolves.toEqual(
      expect.objectContaining({
        status: 'connected',
        token: null,
        isAdmin: false,
        season: 0,
      }),
    )
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer stale-code',
    })
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({})
  })

  it('publishes each stored-server refresh as soon as that server settles', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), { status: 200 })),
    )
    const { refreshStoredServers, setState } = await import('./state.js')
    setState({
      servers: [
        {
          url: 'https://example.com',
          info: serverInfo,
          token: null,
          status: 'unreachable',
          isAdmin: false,
          season: null,
        },
      ],
    })
    const refreshed = vi.fn()

    await refreshStoredServers(refreshed)

    expect(refreshed).toHaveBeenCalledOnce()
  })

  it('refreshes at most four stored servers concurrently', async () => {
    const pending: Array<(response: Response) => void> = []
    let active = 0
    let peak = 0
    let serverRequests = 0
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (!url.endsWith('/server')) {
        const response = url.includes('/manifest')
          ? new Response(JSON.stringify(manifest), { status: 200 })
          : new Response(JSON.stringify({ nodes: [] }), { status: 200 })
        return Promise.resolve(response)
      }
      serverRequests++
      active++
      peak = Math.max(peak, active)
      if (serverRequests > 4) {
        active--
        return Promise.resolve(new Response(JSON.stringify(serverInfo), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        pending.push((response) => {
          active--
          resolve(response)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { refreshStoredServers, setState } = await import('./state.js')
    setState({
      servers: Array.from({ length: 9 }, (_, index) => ({
        url: `https://server-${index}.example.com`,
        info: serverInfo,
        token: null,
        status: 'unreachable' as const,
        isAdmin: false,
        season: null,
      })),
    })

    const refreshing = refreshStoredServers()
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    while (pending.length > 0) {
      pending.shift()?.(new Response(JSON.stringify(serverInfo), { status: 200 }))
      await Promise.resolve()
      await Promise.resolve()
    }
    await refreshing

    expect(peak).toBe(4)
  })

  it('retains a valid read token when an admin operation returns forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    )
    const { getState, renameNode, setState } = await import('./state.js')
    const server = {
      url: 'https://example.com',
      info: { ...serverInfo, auth: 'access_token' as const },
      token: 'read-code',
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    setState({ servers: [server] })

    await expect(renameNode(server, NODE_A, 'Renamed')).resolves.toEqual({
      ok: false,
      message: 'That code cannot change this server — it needs admin access.',
    })
    expect(getState().servers[0]).toEqual(
      expect.objectContaining({
        token: 'read-code',
        status: 'connected',
        isAdmin: false,
      }),
    )
  })

  it('carries an unconsumed manifest tree across an admin-scope downgrade', async () => {
    const nodes = [
      {
        id: NODE_A,
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
        .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...manifest, nodes }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 403 })),
    )
    const { getState, probeServer, renameNode, setState, takeProbedNodes } = await import(
      './state.js'
    )
    const connected = await probeServer('https://example.com', 'read-code')
    setState({ servers: [connected] })

    await renameNode(connected, NODE_A, 'Renamed')
    const downgraded = getState().servers[0]

    expect(downgraded).toEqual(expect.objectContaining({ isAdmin: false, status: 'connected' }))
    expect(downgraded === undefined ? undefined : takeProbedNodes(downgraded)).toEqual(nodes)
  })

  it('marks any rejected credential stale without erasing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    )
    const { getState, renameNode, setState } = await import('./state.js')
    const server = {
      url: 'https://example.com',
      info: { ...serverInfo, auth: 'none' as const },
      token: 'unexpected-but-retained',
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    setState({ servers: [server] })

    await renameNode(server, NODE_A, 'Renamed')

    expect(getState().servers[0]).toEqual(
      expect.objectContaining({
        token: 'unexpected-but-retained',
        status: 'needs-token',
        isAdmin: false,
      }),
    )
  })

  it('does not surface a non-string remote error as a UI message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: { nested: true } }), { status: 409 })),
      ),
    )
    const { renameNode } = await import('./state.js')

    await expect(
      renameNode(
        {
          url: 'https://example.com',
          info: serverInfo,
          token: null,
          status: 'connected',
          isAdmin: true,
          season: 0,
        },
        NODE_A,
        'Renamed',
      ),
    ).resolves.toEqual({ ok: false, message: 'Server said 409.' })
  })

  it('distinguishes a failed node listing from a valid empty collection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
    )
    const { listNodes } = await import('./state.js')
    const server = {
      url: 'https://example.com',
      info: serverInfo,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }

    await expect(listNodes(server)).resolves.toEqual({
      ok: false,
      status: 503,
      message: 'Server said 503.',
    })
  })

  it('rejects an oversized body before parsing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('{}', { headers: { 'content-length': String(16 * 1024 + 1) } }),
        ),
      ),
    )
    const { probeServer } = await import('./state.js')

    await expect(probeServer('https://example.com', null)).resolves.toEqual(
      expect.objectContaining({
        status: 'unreachable',
        error: expect.stringContaining('response exceeds'),
      }),
    )
  })

  it('bounds a server request that never responds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      ),
    )
    const { probeServer } = await import('./state.js')

    const probing = probeServer('https://example.com', null)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(probing).resolves.toEqual(
      expect.objectContaining({
        status: 'unreachable',
        error: 'Error: request timed out',
      }),
    )
  })

  it('allows a large upload longer than the metadata deadline but still times it out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      ),
    )
    const { uploadTemplate } = await import('./state.js')
    let settled = false
    const uploading = uploadTemplate(
      {
        url: 'https://example.com',
        info: serverInfo,
        token: null,
        status: 'connected',
        isAdmin: true,
        season: 0,
      },
      {
        nodeId: NODE_A,
        name: 'Large template',
        originX: 0,
        originY: 0,
        png: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      },
    ).then((result) => {
      settled = true
      return result
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(110_000)

    await expect(uploading).resolves.toEqual({ ok: false, message: 'Error: request timed out' })
  })
})
