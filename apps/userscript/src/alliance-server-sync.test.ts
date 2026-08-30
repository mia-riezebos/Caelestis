import { parseClientMetricsAccept, type TemplateSurface } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockServer {
  readonly url: string
  readonly info: { readonly id: string; readonly name: string; readonly auth: 'none' }
  readonly token: null
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

vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => alliance.active,
  onActiveAllianceSurfaceChange: (listener: () => void) => {
    alliance.listener = listener
    return () => undefined
  },
}))

vi.mock('./state.js', () => ({
  activeServerToken: () => null,
  getState: () => state.current,
  onStateChange: (listener: (next: { servers: readonly MockServer[] }) => void) => {
    state.listener = listener
  },
  sameServerConnection: (left: MockServer, right: MockServer) =>
    left.url === right.url &&
    left.info.id === right.info.id &&
    left.status === right.status &&
    left.season === right.season,
}))

vi.mock('./templates/server-sync.js', () => templates)
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
    expect(
      parseClientMetricsAccept(
        new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get('accept'),
      ),
    ).toMatchObject({
      client: 'userscript',
      transport: 'compatibility-poll',
      reason: 'connect',
    })
    vi.advanceTimersByTime(60_000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(
      parseClientMetricsAccept(
        new Headers(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).get('accept'),
      ),
    ).toMatchObject({
      client: 'userscript',
      transport: 'compatibility-poll',
      reason: 'interval',
    })

    finishNewer(new Response(JSON.stringify(manifest(hq(), 0, 'Newer'))))
    await flush()
    finishOlder(new Response(JSON.stringify(manifest(hq(), 0, 'Older'))))
    await flush()

    expect(allianceManifestFor(connected.url, hq())?.server.name).toBe('Newer')
    expect(templates.syncServerTemplates).toHaveBeenCalledTimes(1)
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

    expect(allianceManifestFor(connected.url, hq())).toBeNull()
    expect(templates.syncServerTemplates).not.toHaveBeenCalled()
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
