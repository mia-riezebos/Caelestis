import { afterEach, describe, expect, it, vi } from 'vitest'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_A = '019fed50-87a1-7523-a88c-bdeafad49682'
const NODE_B = '019fed50-87a1-7523-a88c-bdeafad49683'
const TEMPLATE_ID = '019fed50-87a1-7523-a88c-bdeafad49684'

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

  it('does not trust persisted connectivity, scope, or season', async () => {
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
      }),
    ])
    expect(loadState().customOrder).toEqual(['local:kept'])
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

  it('rejects remote tree cycles before rendering them', async () => {
    const { validateTreeNodes } = await import('./state.js')

    expect(
      validateTreeNodes([
        { id: NODE_A, parentId: NODE_B, path: 'a', name: 'A' },
        { id: NODE_B, parentId: NODE_A, path: 'b', name: 'B' },
      ]),
    ).toBeNull()
  })

  it('rejects malformed root paths regardless of node order', async () => {
    const { validateTreeNodes } = await import('./state.js')
    const parent = { id: NODE_A, parentId: null, path: '/a/b', name: 'Parent' }
    const child = { id: NODE_B, parentId: NODE_A, path: '/a/b/c', name: 'Child' }

    expect(validateTreeNodes([parent, child])).toBeNull()
    expect(validateTreeNodes([child, parent])).toBeNull()
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

  it('rejects malformed manifest members before reporting a verified connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...manifest, nodes: [null] }), { status: 200 }),
        ),
    )
    const { probeServer } = await import('./state.js')

    await expect(probeServer('https://example.com', null)).resolves.toEqual(
      expect.objectContaining({
        status: 'unreachable',
        error: 'TypeError: server returned an invalid manifest',
      }),
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid folder returned by a successful create request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 201 }))),
    )
    const { createNode } = await import('./state.js')

    await expect(
      createNode(
        {
          url: 'https://example.com',
          info: serverInfo,
          token: null,
          status: 'connected',
          isAdmin: true,
          season: 0,
        },
        'Folder',
        null,
      ),
    ).resolves.toEqual({ ok: false, message: 'Server returned an invalid folder.' })
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

  it('requires the canonical created-template identity from a successful upload', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ templateId: TEMPLATE_ID }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ templateId: '' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const { uploadTemplate } = await import('./state.js')
    const connected = {
      url: 'https://example.com',
      info: serverInfo,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    const input = {
      nodeId: NODE_A,
      name: 'Template',
      originX: 0,
      originY: 0,
      png: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    }

    await expect(uploadTemplate(connected, input)).resolves.toEqual({
      ok: true,
      id: TEMPLATE_ID,
    })
    await expect(uploadTemplate(connected, input)).resolves.toEqual({
      ok: false,
      message: 'Server returned an invalid uploaded template.',
    })
  })
})
