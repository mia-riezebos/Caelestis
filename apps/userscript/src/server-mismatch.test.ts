import { BLANK, encodeMismatchMask, WRONG } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  server: {
    url: 'https://templates.example',
    info: { id: 'server', name: 'Templates', auth: 'access_token' as const },
    token: 'read-token',
    status: 'connected' as const,
    isAdmin: false,
    season: 0,
  },
  cache: {
    read: vi.fn<(key: string) => Promise<Uint8Array | null>>(),
    write: vi.fn<(key: string, bytes: Uint8Array) => Promise<void>>(),
    deleteOne: vi.fn<(key: string) => Promise<void>>(),
    deleteTile: vi.fn<(serverUrl: string, tile: { x: number; y: number }) => Promise<void>>(),
    deleteServer: vi.fn<(serverUrl: string) => Promise<void>>(),
  },
}))

vi.mock('./server-mismatch-cache.js', () => ({
  deleteCachedServerMismatch: harness.cache.deleteOne,
  deleteCachedServerMismatches: harness.cache.deleteServer,
  deleteCachedServerMismatchTile: harness.cache.deleteTile,
  readCachedServerMismatch: harness.cache.read,
  writeCachedServerMismatch: harness.cache.write,
}))

vi.mock('./state.js', () => ({
  activeServerToken: () => harness.server.token,
  getState: () => ({ servers: [harness.server] }),
  isCurrentServerConnection: () => true,
}))

const template = {
  serverUrl: harness.server.url,
  serverTemplateId: '01890f3e-7b2c-7abc-8def-0123456789ab',
  serverVersion: '01890f3e-7b2c-7abc-8def-0123456789ac',
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.cache.read.mockResolvedValue(null)
  harness.cache.write.mockResolvedValue()
  harness.cache.deleteOne.mockResolvedValue()
  harness.cache.deleteTile.mockResolvedValue()
  harness.cache.deleteServer.mockResolvedValue()
})

afterEach(() => vi.unstubAllGlobals())

describe('server mismatch masks', () => {
  it('loads one visible template tile with the saved server token', async () => {
    const body = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body.slice().buffer as ArrayBuffer, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const { beginServerMismatchFrame, endServerMismatchFrame, serverMismatchMaskFor } =
      await import('./server-mismatch.js')

    beginServerMismatchFrame()
    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).not.toBeNull())
    endServerMismatchFrame()

    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      `/backend/telemetry/templates/${template.serverTemplateId}/versions/${template.serverVersion}/tiles/3/4/mismatches?season=0`,
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer read-token',
    )
    expect(harness.cache.write).toHaveBeenCalledWith(expect.any(String), body)
  })

  it('draws a persisted mask while its network refresh is still pending', async () => {
    const body = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    const refreshed = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([BLANK]),
    )
    harness.cache.read.mockResolvedValue(body)
    let finishFetch!: (response: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const { beginServerMismatchFrame, endServerMismatchFrame, serverMismatchMaskFor } =
      await import('./server-mismatch.js')

    beginServerMismatchFrame()
    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).not.toBeNull())

    expect(fetch).toHaveBeenCalledOnce()
    expect(harness.cache.write).not.toHaveBeenCalled()
    finishFetch(new Response(refreshed.slice().buffer as ArrayBuffer, { status: 200 }))
    await vi.waitFor(() =>
      expect(harness.cache.write).toHaveBeenCalledWith(expect.any(String), refreshed),
    )
    endServerMismatchFrame()
  })

  it('retains a recently offscreen mask for pan-back', async () => {
    const body = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    const fetch = vi.fn(
      async () => new Response(body.slice().buffer as ArrayBuffer, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const { beginServerMismatchFrame, endServerMismatchFrame, serverMismatchMaskFor } =
      await import('./server-mismatch.js')

    beginServerMismatchFrame()
    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).not.toBeNull())
    const first = serverMismatchMaskFor(template, { x: 3, y: 4 })
    endServerMismatchFrame()

    beginServerMismatchFrame()
    endServerMismatchFrame()
    beginServerMismatchFrame()
    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBe(first)
    endServerMismatchFrame()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('invalidates both memory and persisted masks after a successful paint', async () => {
    const { invalidateServerMismatchTile } = await import('./server-mismatch.js')

    invalidateServerMismatchTile(harness.server.url, { x: 3, y: 4 })

    expect(harness.cache.deleteTile).toHaveBeenCalledWith(harness.server.url, { x: 3, y: 4 })
  })

  it('discards every server mask after a missed live revision', async () => {
    const { invalidateServerMismatches } = await import('./server-mismatch.js')

    invalidateServerMismatches(harness.server.url)

    expect(harness.cache.deleteServer).toHaveBeenCalledWith(harness.server.url)
  })

  it('wakes rendering when server invalidation removes a cached miss', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    const { invalidateServerMismatches, onServerMismatchesChanged, serverMismatchMaskFor } =
      await import('./server-mismatch.js')
    const changed = vi.fn()
    onServerMismatchesChanged(changed)

    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(harness.cache.deleteOne).toHaveBeenCalledOnce())
    invalidateServerMismatches(harness.server.url)

    expect(changed).toHaveBeenCalledOnce()
  })

  it('rejects a response body that finishes after its tile was invalidated', async () => {
    const body = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    let finishBody!: (value: ArrayBuffer) => void
    const response = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishBody = resolve
        }),
    } as Response
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response)
      .mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetch)
    const { invalidateServerMismatchTile, serverMismatchMaskFor } = await import(
      './server-mismatch.js'
    )

    expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
    await vi.waitFor(() => expect(finishBody).toBeTypeOf('function'))
    invalidateServerMismatchTile(harness.server.url, { x: 3, y: 4 })
    finishBody(body.slice().buffer as ArrayBuffer)
    await vi.waitFor(() => {
      expect(serverMismatchMaskFor(template, { x: 3, y: 4 })).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    expect(harness.cache.write).not.toHaveBeenCalled()
  })
})
