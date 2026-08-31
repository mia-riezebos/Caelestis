import type { TemplateSurface } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockServer {
  readonly url: string
  readonly info: { readonly id: string; readonly name: string; readonly auth: 'none' }
  readonly token: string | null
  readonly status: 'connected'
  readonly isAdmin: false
  readonly season: number
}

const alliance = vi.hoisted(() => ({
  active: null as { surface: TemplateSurface } | null,
  listener: null as (() => void) | null,
}))

const state = vi.hoisted(() => ({
  current: { servers: [] as MockServer[] },
  listener: null as ((next: { servers: readonly MockServer[] }) => void) | null,
}))

const templates = vi.hoisted(() => ({
  syncServerTemplates: vi.fn(
    async (
      _server: unknown,
      _known?: readonly unknown[],
      _snapshotCurrent?: () => boolean,
      _surface?: TemplateSurface,
    ): Promise<void> => undefined,
  ),
}))
const nodes = vi.hoisted(() => ({
  forgetSurfaceNodes: vi.fn(),
  rememberNodes: vi.fn(),
}))
const localStore = vi.hoisted(() => ({
  forgetServerSurfaceTemplates: vi.fn(async () => undefined),
}))

vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => alliance.active,
  onActiveAllianceSurfaceChange: (listener: () => void) => {
    alliance.listener = listener
    return () => undefined
  },
}))

vi.mock('./state.js', () => ({
  activeServerToken: (server: MockServer) => server.token,
  getState: () => state.current,
  isCurrentServerConnection: (server: MockServer) =>
    state.current.servers.find((candidate) => candidate.url === server.url) === server,
  onStateChange: (listener: (next: { servers: readonly MockServer[] }) => void) => {
    state.listener = listener
  },
  sameServerConnection: (left: MockServer, right: MockServer) =>
    left.url === right.url &&
    left.token === right.token &&
    left.info.id === right.info.id &&
    left.status === right.status &&
    left.season === right.season,
}))

vi.mock('./templates/server-sync.js', () => templates)
vi.mock('./templates/server-nodes.js', () => nodes)
vi.mock('./templates/local-store.js', () => localStore)
vi.mock('./debug.js', () => ({ count: vi.fn() }))
vi.mock('./server-manifest.js', () => ({
  parseServerManifest: (raw: unknown) => raw,
}))

const connected: MockServer = {
  url: 'https://example.test',
  info: {
    id: '019fed50-87a1-7523-a88c-bdeafad49681',
    name: 'Example',
    auth: 'none',
  },
  token: null,
  status: 'connected',
  isAdmin: false,
  season: 0,
}

const hq = (allianceId = 535_245): TemplateSurface => ({
  kind: 'alliance-headquarters',
  allianceId,
})

const manifest = (surface: TemplateSurface, season = 0, name = 'Example') => ({
  season,
  surface,
  server: { ...connected.info, name },
  nodes: [],
  templates: [],
})

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

describe('alliance server sync', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.clearAllMocks()
    alliance.active = { surface: hq() }
    alliance.listener = null
    state.current = { servers: [connected] }
    state.listener = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the newest response for one server and surface', async () => {
    let finishOlder!: (response: Response) => void
    let finishNewer!: (response: Response) => void
    const older = new Promise<Response>((resolve) => {
      finishOlder = resolve
    })
    const newer = new Promise<Response>((resolve) => {
      finishNewer = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(older).mockReturnValueOnce(newer))
    const { allianceManifestFor, installAllianceServerSync } = await import(
      './alliance-server-sync.js'
    )

    installAllianceServerSync()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)

    finishNewer(new Response(JSON.stringify(manifest(hq(), 0, 'Newer'))))
    await flush()
    finishOlder(new Response(JSON.stringify(manifest(hq(), 0, 'Older'))))
    await flush()

    expect(allianceManifestFor(connected, hq())?.server.name).toBe('Newer')
    expect(templates.syncServerTemplates).toHaveBeenCalledTimes(1)
  })

  it('refreshes a captured server through the current connection lifetime', async () => {
    const replacement = { ...connected, token: 'new-token' }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest(hq(), 0, 'Initial'))))
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest(hq(), 0, 'Replacement')))),
    )
    const { allianceManifestFor, installAllianceServerSync, refreshAllianceManifest } =
      await import('./alliance-server-sync.js')

    installAllianceServerSync()
    await flush()
    state.current = { servers: [replacement] }
    await refreshAllianceManifest(connected, hq())

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer new-token',
    })
    expect(allianceManifestFor(replacement, hq())?.server.name).toBe('Replacement')
    expect(templates.syncServerTemplates).toHaveBeenLastCalledWith(
      replacement,
      [],
      expect.any(Function),
      hq(),
    )
  })

  it('rejects a manifest from a different server season', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest(hq(), 1)))),
    )
    const { allianceManifestFor, installAllianceServerSync } = await import(
      './alliance-server-sync.js'
    )

    installAllianceServerSync()
    await flush()

    expect(allianceManifestFor(connected, hq())).toBeNull()
    expect(templates.syncServerTemplates).not.toHaveBeenCalled()
  })

  it('records exact-surface folder parents before syncing templates', async () => {
    const manifestNodes = [{ id: 'alliance-folder', parentId: null }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...manifest(hq()), nodes: manifestNodes }))),
    )
    const { installAllianceServerSync } = await import('./alliance-server-sync.js')

    installAllianceServerSync()
    await flush()

    await vi.waitFor(() => {
      expect(nodes.rememberNodes).toHaveBeenCalledWith(connected.url, manifestNodes, hq())
    })
    expect(nodes.rememberNodes.mock.invocationCallOrder[0]).toBeLessThan(
      templates.syncServerTemplates.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('retires admitted surface state before polling a replacement connection', async () => {
    const replacement = { ...connected, token: 'new-token' }
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest(hq(), 0, 'Old'))))
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    )
    const { allianceManifestFor, installAllianceServerSync } = await import(
      './alliance-server-sync.js'
    )
    installAllianceServerSync()
    await vi.waitFor(() => {
      expect(allianceManifestFor(connected, hq())?.server.name).toBe('Old')
    })

    state.current = { servers: [replacement] }
    state.listener?.(state.current)

    expect(allianceManifestFor(replacement, hq())).toBeNull()
    expect(nodes.forgetSurfaceNodes).toHaveBeenCalledWith(connected.url, hq())
    expect(localStore.forgetServerSurfaceTemplates).toHaveBeenCalledWith(connected.url, hq())
    await flush()
    expect(allianceManifestFor(replacement, hq())).toBeNull()
  })

  it('does not poll for cosmetic state changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest(hq())))),
    )
    const { installAllianceServerSync } = await import('./alliance-server-sync.js')
    installAllianceServerSync()
    await flush()
    vi.mocked(fetch).mockClear()

    state.listener?.({ servers: [{ ...connected, info: { ...connected.info, name: 'Renamed' } }] })
    await flush()

    expect(fetch).not.toHaveBeenCalled()
  })

  it('retires the previous surface before polling the next one', async () => {
    let finishRetirement!: () => void
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve
    })
    templates.syncServerTemplates.mockImplementation(
      async (_server, known: readonly unknown[] | undefined) =>
        known?.length === 0 ? await retirement : undefined,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest(alliance.active?.surface ?? hq())))),
    )
    const { installAllianceServerSync } = await import('./alliance-server-sync.js')
    installAllianceServerSync()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    alliance.active = { surface: { kind: 'alliance-banner', allianceId: 535_245 } }
    alliance.listener?.()
    await flush()

    expect(templates.syncServerTemplates).toHaveBeenCalledWith(connected, [], undefined, hq())
    expect(fetch).toHaveBeenCalledTimes(1)

    finishRetirement()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
