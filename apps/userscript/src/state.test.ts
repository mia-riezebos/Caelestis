import { afterEach, describe, expect, it, vi } from 'vitest'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_A = '019fed50-87a1-7523-a88c-bdeafad49682'
const NODE_B = '019fed50-87a1-7523-a88c-bdeafad49683'

const serverInfo = { id: SERVER_ID, name: 'Caelestis', auth: 'none' as const }
const manifest = {
  version: '3b7f6148884517e03bb2807e18116677',
  season: 7,
  server: serverInfo,
  nodes: [],
  templates: [],
  tiles: [],
}

afterEach(() => {
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

  it('uses the validated manifest season for admin probes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(serverInfo), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { probeServer } = await import('./state.js')

    await expect(probeServer('https://example.com/', null)).resolves.toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        status: 'connected',
        season: 7,
        isAdmin: true,
      }),
    )
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://example.com/admin/nodes?season=7')
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
})
