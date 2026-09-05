import {
  type LiveTileOfferBatch,
  type LiveTileOfferCacheResponse,
  type LiveTileOfferResponse,
  type LiveTileUpload,
  MAX_TILE_OFFERS,
  type PaintEvent,
  type SyncTransport,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from './server-cache.js'
import type { ConnectedServer } from './state.js'

const harness = vi.hoisted(() => ({
  serverContents: null as ((server: unknown, contents: unknown) => void) | null,
  fetchedTile: null as
    | ((tile: { x: number; y: number }, bytes: Uint8Array, observedAt: number) => void)
    | null,
  tileInterest: null as ((tile: { x: number; y: number }) => boolean) | null,
  acceptedPaint: null as ((paint: unknown) => void) | null,
  stateListeners: [] as Array<() => void>,
  retiredServers: new WeakSet<object>(),
  state: {
    shareTiles: true,
    reportPaints: true,
    servers: [] as unknown[],
    hiddenScopes: [] as string[],
  },
}))

const coordinator = vi.hoisted(() => ({
  liveHealthy: false,
  revision: undefined as string | undefined,
  liveTileOffer: vi.fn<
    (
      server: ConnectedServer,
      batch: LiveTileOfferBatch,
    ) => Promise<LiveTileOfferCacheResponse | null>
  >(async () => null),
  livePaint: vi.fn<
    (
      server: ConnectedServer,
      event: PaintEvent,
    ) => Promise<{
      type: 'paint-result'
      eventId: string
      result: 'recorded' | 'partial' | 'duplicate'
      error?: 'forbidden' | 'invalid' | 'unavailable'
    } | null>
  >(async () => null),
  liveFullTileOffer: vi.fn<
    (
      server: ConnectedServer,
      batch: LiveTileOfferBatch,
    ) => Promise<{
      type: 'tile-offer-result'
      response: LiveTileOfferResponse
      error?: 'forbidden' | 'invalid' | 'unavailable'
    } | null>
  >(async () => null),
  liveTileUpload: vi.fn<
    (
      server: ConnectedServer,
      upload: Omit<LiveTileUpload, 'type' | 'requestId'>,
      bytes: Uint8Array,
    ) => Promise<{
      type: 'tile-upload-result'
      deliveryId: string
      accepted: boolean
      error?: 'forbidden' | 'invalid' | 'unavailable'
    } | null>
  >(async () => null),
  snapshots: [] as unknown[],
  requests: [] as Array<{ reason: string; resourceId?: string }>,
  resources: new Map<
    string,
    {
      refresh: (
        server: unknown,
        reason: 'connect' | 'manifest-applied',
        transport: SyncTransport,
      ) => Promise<unknown>
      applyLiveEvent?: (server: ConnectedServer, event: unknown) => boolean
    }
  >(),
}))

const debug = vi.hoisted(() => ({ count: vi.fn(), warn: vi.fn() }))
const mismatch = vi.hoisted(() => ({
  invalidateServer: vi.fn(),
  invalidateTile: vi.fn(),
}))
const account = vi.hoisted(() => ({
  identity: { wplaceUserId: 42, displayName: 'Mía 🎨' } as {
    wplaceUserId: number
    displayName: string
  } | null,
  identityUnavailable: false,
  loadAccount: vi.fn<() => Promise<void>>(async () => undefined),
}))

vi.mock('./debug.js', () => debug)
vi.mock('./server-mismatch.js', () => ({
  invalidateServerMismatches: mismatch.invalidateServer,
  invalidateServerMismatchTile: mismatch.invalidateTile,
}))
vi.mock('./state.js', () => ({
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
  getState: () => harness.state,
  isCurrentServerConnection: (server: object) => !harness.retiredServers.has(server),
  serverConnectionIdentity: (server: object) => server,
  serverConnectionSignal: () => new AbortController().signal,
  onServerContents: (listener: (server: unknown, contents: unknown) => void) => {
    harness.serverContents = listener
    return vi.fn()
  },
  onStateChange: (listener: () => void) => {
    harness.stateListeners.push(listener)
    return vi.fn()
  },
}))
vi.mock('./server-sync-coordinator.js', () => ({
  applyServerSyncDelta: (
    _server: unknown,
    _scope: string,
    _resource: string,
    _baseRevision: string,
    _revision: string,
    apply: () => void,
  ) => {
    apply()
    return 'applied'
  },
  applyServerSyncSnapshot: (
    _server: unknown,
    _scope: string,
    _resource: string,
    _startedRevision: string | undefined,
    result: unknown,
    apply: () => void,
  ) => {
    coordinator.snapshots.push(result)
    apply()
    return 'applied'
  },
  applyServerSyncRevision: (
    _server: unknown,
    _scope: string,
    _resource: string,
    revision: string,
  ) => {
    coordinator.revision = revision
  },
  serverSyncRevision: () => coordinator.revision,
  serverLiveSyncHealthy: () => coordinator.liveHealthy,
  serverLiveSyncVersion: (server: ConnectedServer) =>
    server.info?.liveSyncMax ?? server.info?.liveSync,
  requestLiveTileOfferCache: coordinator.liveTileOffer,
  requestLivePaint: coordinator.livePaint,
  requestLiveTileOffer: coordinator.liveFullTileOffer,
  requestLiveTileUpload: coordinator.liveTileUpload,
  registerServerSyncResource: (resource: {
    id: string
    refresh: (
      server: unknown,
      reason: 'connect' | 'manifest-applied',
      transport: SyncTransport,
    ) => Promise<unknown>
  }) => {
    coordinator.resources.set(resource.id, resource)
    queueMicrotask(() => {
      for (const server of harness.state.servers)
        void resource.refresh(server, 'connect', 'compatibility-poll')
    })
  },
  requestServerSync: (reason: 'connect' | 'manifest-applied', resourceId?: string) => {
    coordinator.requests.push({
      reason,
      ...(resourceId === undefined ? {} : { resourceId }),
    })
    queueMicrotask(() => {
      for (const [id, resource] of coordinator.resources) {
        if (resourceId !== undefined && resourceId !== id) continue
        for (const server of harness.state.servers)
          void resource.refresh(server, reason, 'compatibility-poll')
      }
    })
  },
}))
vi.mock('./tile-transform.js', () => ({
  onAcceptedPaint: (listener: (paint: unknown) => void) => {
    harness.acceptedPaint = listener
    return vi.fn()
  },
  onFetchedTile: (
    listener: (tile: { x: number; y: number }, bytes: Uint8Array, observedAt: number) => void,
    interest: (tile: { x: number; y: number }) => boolean,
  ) => {
    harness.fetchedTile = listener
    harness.tileInterest = interest
    return vi.fn()
  },
}))
vi.mock('./wplace-account.js', () => ({
  accountIdentity: () => account.identity,
  accountIdentityKnownUnavailable: () => account.identityUnavailable,
  loadAccount: account.loadAccount,
}))

const server: ConnectedServer = {
  url: 'https://templates.example',
  info: { id: 'server', name: 'Templates', auth: 'access_token' },
  token: 'report-token',
  status: 'connected',
  isAdmin: false,
  season: 0,
}

const template: ServerTemplate = {
  id: '01890f3e-7b2c-7abc-8def-0123456789ab',
  nodeId: null,
  name: 'Template',
  version: 'version',
  totalPixels: 3,
  published: true,
  updatedAt: 1,
  bbox: { minX: 1_000, minY: 2_000, maxX: 1_003, maxY: 2_001 },
  chunks: [{ tile: '1/2', hash: 'chunk' }],
}

beforeEach(() => {
  vi.clearAllTimers()
  vi.resetModules()
  vi.clearAllMocks()
  account.identity = { wplaceUserId: 42, displayName: 'Mía 🎨' }
  account.identityUnavailable = false
  account.loadAccount.mockImplementation(async () => undefined)
  harness.serverContents = null
  harness.fetchedTile = null
  harness.tileInterest = null
  harness.acceptedPaint = null
  harness.stateListeners = []
  harness.retiredServers = new WeakSet<object>()
  coordinator.resources.clear()
  coordinator.liveHealthy = false
  coordinator.revision = undefined
  coordinator.liveTileOffer.mockReset()
  coordinator.liveTileOffer.mockResolvedValue(null)
  coordinator.livePaint.mockReset()
  coordinator.livePaint.mockResolvedValue(null)
  coordinator.liveFullTileOffer.mockReset()
  coordinator.liveFullTileOffer.mockResolvedValue(null)
  coordinator.liveTileUpload.mockReset()
  coordinator.liveTileUpload.mockResolvedValue(null)
  coordinator.snapshots = []
  coordinator.requests = []
  harness.state = {
    shareTiles: true,
    reportPaints: true,
    servers: [server],
    hiddenScopes: [],
  }
})

afterEach(async () => {
  harness.state = { ...harness.state, shareTiles: false }
  for (const listener of harness.stateListeners) listener()
  vi.clearAllTimers()
  vi.useRealTimers()
  await new Promise((resolve) => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('server telemetry client', () => {
  it('carries an authoritative status revision into the shared coordinator', async () => {
    harness.state = { ...harness.state, servers: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ revision: 12, templates: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    const resource = coordinator.resources.get('telemetry-status')
    await expect(resource?.refresh(server, 'connect', 'recovery')).resolves.toEqual({
      status: 'skipped',
    })
    expect(coordinator.snapshots).toEqual([
      {
        status: 'unchanged',
        revision: '12',
      },
    ])
    expect(mismatch.invalidateServer).not.toHaveBeenCalled()
  })

  it('invalidates every mismatch mask after a confirmed status revision change', async () => {
    harness.state = { ...harness.state, servers: [] }
    coordinator.revision = '11'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ revision: 12, templates: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    const resource = coordinator.resources.get('telemetry-status')
    await resource?.refresh(server, 'connect', 'recovery')

    expect(mismatch.invalidateServer).toHaveBeenCalledWith(server.url)
  })

  it('invalidates mismatch masks from exact live status tiles', async () => {
    harness.state = { ...harness.state, servers: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ revision: 1, templates: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    const resource = coordinator.resources.get('telemetry-status')
    expect(
      resource?.applyLiveEvent?.(server, {
        baseRevision: 1,
        revision: 2,
        templates: [],
        removedTemplateIds: [],
        invalidatedTiles: ['1/2'],
      }),
    ).toBe(true)
    expect(mismatch.invalidateTile).toHaveBeenCalledWith(server.url, { x: 1, y: 2 })
  })

  it('invalidates every mismatch mask when a live status gap has unknown tiles', async () => {
    harness.state = { ...harness.state, servers: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ revision: 1, templates: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    const resource = coordinator.resources.get('telemetry-status')
    expect(
      resource?.applyLiveEvent?.(server, {
        baseRevision: 1,
        revision: 3,
        templates: [],
        removedTemplateIds: [],
        invalidateAllTiles: true,
      }),
    ).toBe(true)
    expect(mismatch.invalidateServer).toHaveBeenCalledWith(server.url)
    expect(mismatch.invalidateTile).not.toHaveBeenCalled()
  })

  it('admits alarms only for current visible templates whose visibility chain is enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/alarms')) {
          return Response.json({
            alarms: [
              {
                id: '01890f3e-7b2c-7abc-8def-0123456789ac',
                templateId: template.id,
                kind: 'regression',
                pixelsLost: 12,
                firstSeen: 1_000,
                lastSeen: 2_000,
              },
            ],
          })
        }
        return Response.json({ templates: [] })
      }),
    )
    const { installTelemetry, onServerAlarmChange, serverAlarmFor } = await import('./telemetry.js')
    const changed = vi.fn()
    onServerAlarmChange(changed)
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    await vi.waitFor(() =>
      expect(serverAlarmFor(server, template)).toMatchObject({
        kind: 'regression',
        pixelsLost: 12,
      }),
    )

    harness.serverContents?.(server, {
      nodes: [],
      templates: [{ ...template }],
    })
    expect(serverAlarmFor(server, template)).toBeNull()
    await vi.waitFor(() => expect(serverAlarmFor(server, template)?.id).toBeDefined())

    const unpublished = { ...template, published: false }
    harness.serverContents?.(server, { nodes: [], templates: [unpublished] })
    await vi.waitFor(() => expect(serverAlarmFor(server, unpublished)?.id).toBeDefined())

    harness.state = {
      ...harness.state,
      hiddenScopes: [`srv:${encodeURIComponent(server.url)}:${template.id}`],
    }
    harness.stateListeners.at(-1)?.()
    expect(serverAlarmFor(server, template)).toBeNull()
    expect(changed).toHaveBeenCalled()
  })

  it('reads initial alarms once and refreshes both surfaces after a later manifest change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ templates: [], alarms: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    coordinator.requests = []

    harness.serverContents?.(server, { revision: '1', nodes: [], templates: [template] })

    expect(coordinator.requests).toEqual([
      { reason: 'manifest-applied', resourceId: 'telemetry-alarms' },
    ])
    coordinator.requests = []

    harness.serverContents?.(server, { revision: '2', nodes: [], templates: [template] })

    expect(coordinator.requests).toEqual([
      { reason: 'manifest-applied', resourceId: 'telemetry-status' },
      { reason: 'manifest-applied', resourceId: 'telemetry-alarms' },
    ])
  })

  it('does not apply an alarm response parsed against superseded coverage', async () => {
    let releaseBody: ((value: unknown) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes('/telemetry/alarms')) return Response.json({ templates: [] })
        return {
          ok: true,
          json: () =>
            new Promise((resolve) => {
              releaseBody = resolve
            }),
        } as Response
      }),
    )
    const { installTelemetry, onServerAlarmChange, serverAlarmFor } = await import('./telemetry.js')
    const changed = vi.fn()
    onServerAlarmChange(changed)
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    const resource = coordinator.resources.get('telemetry-alarms')
    const refreshing = resource?.refresh(server, 'connect', 'recovery')
    await vi.waitFor(() => expect(releaseBody).toBeTypeOf('function'))

    harness.serverContents?.(server, {
      nodes: [],
      templates: [{ ...template }],
    })
    releaseBody?.({
      version: 'a'.repeat(64),
      alarms: [
        {
          id: '01890f3e-7b2c-7abc-8def-0123456789ac',
          templateId: template.id,
          kind: 'regression',
          pixelsLost: 12,
          firstSeen: 1_000,
          lastSeen: 2_000,
        },
      ],
    })

    await expect(refreshing).resolves.toEqual({ status: 'failed' })
    expect(serverAlarmFor(server, template)).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps an in-flight alarm response valid across an unchanged revisioned manifest', async () => {
    let releaseBody: ((value: unknown) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes('/telemetry/alarms')) return Response.json({ templates: [] })
        return {
          ok: true,
          json: () =>
            new Promise((resolve) => {
              releaseBody = resolve
            }),
        } as Response
      }),
    )
    const { installTelemetry, serverAlarmFor } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { revision: '1', nodes: [], templates: [template] })
    const resource = coordinator.resources.get('telemetry-alarms')
    const refreshing = resource?.refresh(server, 'connect', 'recovery')
    await vi.waitFor(() => expect(releaseBody).toBeTypeOf('function'))

    harness.serverContents?.(server, {
      revision: '1',
      nodes: [],
      templates: [{ ...template }],
    })
    releaseBody?.({
      version: 'a'.repeat(64),
      alarms: [
        {
          id: '01890f3e-7b2c-7abc-8def-0123456789ac',
          templateId: template.id,
          kind: 'regression',
          pixelsLost: 12,
          firstSeen: 1_000,
          lastSeen: 2_000,
        },
      ],
    })

    await expect(refreshing).resolves.toEqual({ status: 'changed', revision: 'a'.repeat(64) })
    expect(serverAlarmFor(server, template)?.pixelsLost).toBe(12)
  })

  it('reads tile bodies only while a connected server may want them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ templates: [] })),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    expect(harness.tileInterest?.({ x: 1, y: 2 })).toBe(true)
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    expect(harness.tileInterest?.({ x: 1, y: 2 })).toBe(true)
    expect(harness.tileInterest?.({ x: 9, y: 9 })).toBe(false)

    harness.state = { ...harness.state, shareTiles: false }
    expect(harness.tileInterest?.({ x: 1, y: 2 })).toBe(false)
  })

  it('does not reread status after an unchanged offer while live sync is healthy', async () => {
    coordinator.liveHealthy = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/telemetry/tiles/offers')) {
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return Response.json({ templates: [], alarms: [] })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { revision: '1', nodes: [], templates: [template] })
    coordinator.requests = []

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)
    await vi.waitFor(() =>
      expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 1),
    )

    expect(coordinator.requests).not.toContainEqual({
      reason: 'post-offer',
      resourceId: 'telemetry-status',
    })
  })

  it('replays tiles and accepted paints observed before manifest coverage arrives', async () => {
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          return Response.json({ wanted: ['1/2'] })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 1,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(requests.some((url) => url.includes('/telemetry/tiles/offers'))).toBe(false)
    expect(requests.some((url) => url.includes('/telemetry/paints'))).toBe(false)

    harness.serverContents?.(server, { nodes: [], templates: [template] })

    await vi.waitFor(() => {
      expect(requests.some((url) => url.includes('/telemetry/tiles/1/2/'))).toBe(true)
      expect(requests.some((url) => url.includes('/telemetry/paints'))).toBe(true)
    })
  })

  it('retains coverage for quiet tiles when one tile fills the recent replay cache', async () => {
    const offeredTiles: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as {
            offers: Array<{ tile: string }>
          }
          offeredTiles.push(...body.offers.map((offer) => offer.tile))
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    harness.fetchedTile?.({ x: 2, y: 2 }, new Uint8Array([2]), 1_800_000_000)
    for (let index = 0; index < 31; index++)
      harness.fetchedTile?.({ x: 3, y: 2 }, new Uint8Array([3]), 1_800_000_000 + index)
    await new Promise((resolve) => setTimeout(resolve, 25))

    harness.serverContents?.(server, { nodes: [], templates: [template] })

    await vi.waitFor(() => expect(offeredTiles).toContain('1/2'))
  })

  it('reports only covered tiles and reads progress back from the server', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.includes('/telemetry/status')) {
          return Response.json({
            templates: [
              {
                templateId: template.id,
                correct: 1,
                wrong: 1,
                blank: 1,
                total: 3,
                colours: [
                  { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
                  { index: 1, correct: 0, wrong: 1, blank: 0, total: 1 },
                  { index: 2, correct: 0, wrong: 0, blank: 1, total: 1 },
                ],
                observedAt: 1_000,
              },
            ],
          })
        }
        if (url.endsWith('/telemetry/tiles/offers')) {
          return Response.json({
            wanted: ['1/2'],
            coverageToken: '01890f3e-7b2c-4abc-8def-000000000001',
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry, serverColourProgressFor, serverProgressFor } = await import(
      './telemetry.js'
    )
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 9, y: 9 }, new Uint8Array([9]), 1_800_000_000)
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.includes('/telemetry/tiles/1/2/'))).toBe(true),
    )
    expect(requests.some(({ url }) => url.includes('/telemetry/tiles/9/9/'))).toBe(false)
    const offer = requests.find(({ url }) => url.endsWith('/telemetry/tiles/offers'))
    expect(JSON.parse(String(offer?.init?.body))).toMatchObject({
      wplaceUserId: 42,
      displayName: 'Mía 🎨',
      season: 0,
      offers: [{ tile: '1/2' }],
    })
    const upload = requests.find(({ url }) => url.includes('/telemetry/tiles/1/2/'))
    expect(new Headers(upload?.init?.headers).get('x-caelestis-display-name')).toBe(
      encodeURIComponent('Mía 🎨'),
    )
    expect(new Headers(upload?.init?.headers).get('x-caelestis-tile-coverage-token')).toBe(
      '01890f3e-7b2c-4abc-8def-000000000001',
    )
    await vi.waitFor(() =>
      expect(serverProgressFor(server, template)).toEqual({
        completed: 1,
        mismatched: 1,
        unpainted: 1,
        known: 3,
        total: 3,
      }),
    )
    expect(serverColourProgressFor(server, template)).toEqual([
      {
        index: 0,
        completed: 1,
        mismatched: 0,
        unpainted: 0,
        known: 1,
        total: 1,
      },
      {
        index: 1,
        completed: 0,
        mismatched: 1,
        unpainted: 0,
        known: 1,
        total: 1,
      },
      {
        index: 2,
        completed: 0,
        mismatched: 0,
        unpainted: 1,
        known: 1,
        total: 1,
      },
    ])
  })

  it('applies offered progress without another status read', async () => {
    let offered = false
    let statusReadsAfterOffer = 0
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/telemetry/status')) {
          if (!offered) return Response.json({ revision: 1, templates: [] })
          statusReadsAfterOffer += 1
          return Response.json({ revision: 2, templates: [] })
        }
        if (url.endsWith('/telemetry/tiles/offers')) {
          offered = true
          return Response.json({
            wanted: [],
            status: {
              baseRevision: 1,
              revision: 2,
              templates: [
                {
                  templateId: template.id,
                  correct: 1,
                  wrong: 1,
                  blank: 1,
                  total: 3,
                  observedAt: 1_000,
                },
              ],
              removedTemplateIds: [],
            },
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry, serverProgressFor } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(serverProgressFor(server, template)).not.toBeNull())
    expect(statusReadsAfterOffer).toBe(0)
    expect(requests.some((url) => url.includes('/telemetry/tiles/1/2/'))).toBe(false)
    expect(serverProgressFor(server, template)).toEqual({
      completed: 1,
      mismatched: 1,
      unpainted: 1,
      known: 3,
      total: 3,
    })
  })

  it('bounds a successful wanted upload response before reconciling its missing delta', async () => {
    coordinator.liveHealthy = true
    let offered = false
    let statusReadsAfterOffer = 0
    const parseUpload = vi.fn(async () => ({}))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) {
          if (!offered) return Response.json({ revision: 1, templates: [] })
          statusReadsAfterOffer += 1
          return Response.json({ revision: 3, templates: [] })
        }
        if (url.endsWith('/telemetry/tiles/offers')) {
          offered = true
          return Response.json({
            wanted: ['1/2'],
            status: {
              baseRevision: 1,
              revision: 2,
              templates: [],
              removedTemplateIds: [],
            },
          })
        }
        if (url.includes('/telemetry/tiles/1/2/')) {
          const response = new Response('{}', {
            headers: { 'content-length': String(64 * 1024 + 1) },
          })
          Object.defineProperty(response, 'json', { value: parseUpload })
          return response
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(statusReadsAfterOffer).toBe(1))
    expect(parseUpload).not.toHaveBeenCalled()
  })

  it('does not reoffer an observation after its requested upload succeeds', async () => {
    let offers = 0
    let uploads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return Response.json({ wanted: ['1/2'] })
        }
        if (url.includes('/telemetry/tiles/1/2/')) {
          uploads++
          return Response.json({})
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      revision: 'manifest-1',
      nodes: [],
      templates: [template],
    })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)
    await vi.waitFor(() => expect(uploads).toBe(1))
    harness.serverContents?.(server, {
      revision: 'manifest-1',
      nodes: [],
      templates: [template],
    })
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(offers).toBe(1)
    expect(uploads).toBe(1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-avoided', 1)
  })

  it('retains a failed observation after the recent replay cache evicts it', async () => {
    const offeredTiles: string[] = []
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          attempts++
          const body = JSON.parse(String(init?.body)) as {
            offers: Array<{ tile: string }>
          }
          offeredTiles.push(...body.offers.map((offer) => offer.tile))
          if (attempts <= 3) return new Response(null, { status: 503 })
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(attempts).toBe(3))
    for (let index = 0; index < 33; index++)
      harness.fetchedTile?.({ x: 100 + index, y: 9 }, new Uint8Array([index]), 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 25))
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    await vi.waitFor(() => expect(attempts).toBe(4), { timeout: 2_000 })
    expect(offeredTiles).toEqual(['1/2', '1/2', '1/2', '1/2'])
  })

  it('drops retained retries when tile sharing is disabled', async () => {
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          attempts++
          return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(attempts).toBe(3))

    harness.state = { ...harness.state, shareTiles: false }
    for (const listener of harness.stateListeners) listener()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(attempts).toBe(3)
  })

  it('does not start a requested upload after tile sharing is disabled', async () => {
    let settleOffer: ((response: Response) => void) | undefined
    let uploads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers'))
          return new Promise<Response>((resolve) => {
            settleOffer = resolve
          })
        if (url.includes('/telemetry/tiles/1/2/')) uploads++
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(settleOffer).toBeDefined())

    harness.state = { ...harness.state, shareTiles: false }
    for (const listener of harness.stateListeners) listener()
    settleOffer?.(Response.json({ wanted: ['1/2'] }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(uploads).toBe(0)
  })

  it('does not fall back to HTTP after sharing is disabled during a live request', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveTileOffers: 1 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.liveHealthy = true
    let settleLive: ((response: LiveTileOfferCacheResponse | null) => void) | undefined
    coordinator.liveTileOffer.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleLive = resolve
        }),
    )
    let httpOffers = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/tiles/offers')) httpOffers++
        if (url.includes('/telemetry/status')) return Response.json({ revision: 1, templates: [] })
        if (url.includes('/telemetry/alarms')) return Response.json({ alarms: [] })
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(settleLive).toBeDefined())

    harness.state = { ...harness.state, shareTiles: false }
    for (const listener of harness.stateListeners) listener()
    settleLive?.(null)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(httpOffers).toBe(0)
  })

  it('does not rebind a retained report across seasons', async () => {
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          attempts++
          return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(attempts).toBe(3))

    const nextSeason = { ...server, season: 1 }
    harness.retiredServers.add(server)
    harness.state = { ...harness.state, servers: [nextSeason] }
    harness.serverContents?.(nextSeason, { nodes: [], templates: [template] })
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(attempts).toBe(3)
  })

  it('drops retained retries when manifest coverage removes the tile', async () => {
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          attempts++
          return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(attempts).toBe(3))

    harness.serverContents?.(server, { nodes: [], templates: [] })
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(attempts).toBe(3)
  })

  it('does not restore an in-flight retry after its report server is replaced', async () => {
    const mirror = { ...server, url: 'https://mirror.example' }
    harness.state = { ...harness.state, servers: [server, mirror] }
    let settleRemovedOffer: ((response: Response) => void) | undefined
    const attempts = new Map<string, string[][]>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const origin = new URL(url).origin
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          const held = attempts.get(origin) ?? []
          held.push(body.offers.map((offer) => offer.tile))
          attempts.set(origin, held)
          if (origin === server.url && held.length === 1)
            return new Promise<Response>((resolve) => {
              settleRemovedOffer = resolve
            })
          if (origin === server.url && held.length <= 3) return new Response(null, { status: 503 })
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    const mirrorChunks = Array.from({ length: 33 }, (_, index) => ({
      tile: `${100 + index}/9`,
      hash: `mirror-${index}`,
    }))
    harness.serverContents?.(mirror, {
      nodes: [],
      templates: [{ ...template, chunks: mirrorChunks }],
    })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(settleRemovedOffer).toBeDefined())

    for (let index = 0; index < mirrorChunks.length; index++)
      harness.fetchedTile?.(
        { x: 100 + index, y: 9 },
        new Uint8Array([index]),
        1_800_000_001 + index,
      )
    await vi.waitFor(() =>
      expect(attempts.get(mirror.url)?.flat()).toHaveLength(mirrorChunks.length),
    )

    const replacement = { ...server }
    harness.retiredServers.add(server)
    harness.state = { ...harness.state, servers: [mirror, replacement] }
    for (const listener of harness.stateListeners) listener()
    harness.serverContents?.(replacement, {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [
            { tile: '1/2', hash: 'chunk' },
            { tile: '2/2', hash: 'replacement' },
          ],
        },
      ],
    })
    harness.fetchedTile?.({ x: 2, y: 2 }, new Uint8Array([2]), 1_800_000_100)
    settleRemovedOffer?.(new Response(null, { status: 503 }))
    await vi.waitFor(() => expect(attempts.get(server.url)).toHaveLength(4))
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(attempts.get(server.url)?.slice(3)).toEqual([['2/2']])
  })

  it('keeps failed tile retries inside the bounded recent replay window', async () => {
    const chunks = Array.from({ length: 35 }, (_, index) => ({
      tile: `${index}/9`,
      hash: `hash-${index}`,
    }))
    const batches: string[][] = []
    let available = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          const tiles = body.offers.map((offer) => offer.tile)
          batches.push(tiles)
          return available
            ? Response.json({ wanted: [], acknowledged: tiles, rejected: [] })
            : new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      nodes: [],
      templates: [{ ...template, chunks }],
    })

    for (let index = 0; index < 34; index++)
      harness.fetchedTile?.({ x: index, y: 9 }, new Uint8Array([index]), 1_800_000_000 + index)
    await vi.waitFor(() => expect(batches).toHaveLength(3))
    expect(new Set(batches[0])).toEqual(new Set(chunks.slice(0, 34).map((chunk) => chunk.tile)))

    available = true
    harness.fetchedTile?.({ x: 34, y: 9 }, new Uint8Array([34]), 1_800_000_034)
    await vi.waitFor(() => expect(batches).toHaveLength(4))
    const retried = new Set(batches[3])
    expect(retried.size).toBe(33)
    expect(retried.has('34/9')).toBe(true)
    expect(batches[0]?.filter((tile) => retried.has(tile))).toHaveLength(32)
    await vi.waitFor(() =>
      expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 33),
    )
  })

  it('rotates ambiguous batches so later observations are offered', async () => {
    const batches: string[][] = []
    const chunks = Array.from({ length: MAX_TILE_OFFERS + 1 }, (_, index) => ({
      tile: `${index}/1`,
      hash: `hash-${index}`,
    }))
    const wideTemplate = { ...template, chunks }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as {
            offers: Array<{ tile: string }>
          }
          const tiles = body.offers.map((offer) => offer.tile)
          batches.push(tiles)
          return batches.length === 1
            ? Response.json({ wanted: [] })
            : Response.json({ wanted: [], acknowledged: tiles, rejected: [] })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [wideTemplate] })
    for (let index = 0; index <= MAX_TILE_OFFERS; index++)
      harness.fetchedTile?.({ x: index, y: 1 }, new Uint8Array([index]), 1_800_000_000)
    await vi.waitFor(() => expect(batches).toHaveLength(1))
    await vi.waitFor(() =>
      expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 0),
    )
    harness.serverContents?.(server, { nodes: [], templates: [wideTemplate] })

    await vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(2))
    expect(batches[1]).toContain(`${MAX_TILE_OFFERS}/1`)
    expect(new Set(batches.flat())).toEqual(new Set(chunks.map((chunk) => chunk.tile)))
    await vi.waitFor(() =>
      expect(debug.count).toHaveBeenCalledWith(
        'telemetry:tile-offers-accepted',
        batches[1]?.length,
      ),
    )
  })

  it('reports distinct tile fetches even when the server just acknowledged the same content', async () => {
    const offers: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers.push(JSON.parse(String(init?.body)))
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(offers).toHaveLength(1))
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(offers).toHaveLength(2))

    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-requested', 1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 1)
  })

  it('sends ten distinct same-hash observations over live cache without an HTTP offer', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveTileOffers: 1 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.liveHealthy = true
    coordinator.liveTileOffer.mockImplementation(async (_server, batch) => ({
      acknowledgedDeliveryIds: batch.offers.map(
        (offer: { deliveryId: string }) => offer.deliveryId,
      ),
      unresolvedDeliveryIds: [],
    }))
    const httpOffers: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/tiles/offers')) httpOffers.push(url)
        if (url.includes('/telemetry/status')) return Response.json({ revision: 1, templates: [] })
        if (url.includes('/telemetry/alarms')) return Response.json({ alarms: [] })
        return Response.json({ wanted: [], acknowledged: ['1/2'], rejected: [] })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })
    const bytes = new Uint8Array([1, 2, 3])

    for (let index = 0; index < 10; index++) {
      harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000 + index)
      await vi.waitFor(() => expect(coordinator.liveTileOffer).toHaveBeenCalledTimes(index + 1))
    }

    expect(httpOffers).toEqual([])
    const deliveryIds = coordinator.liveTileOffer.mock.calls.flatMap(([, batch]) =>
      batch.offers.map((offer: { deliveryId: string }) => offer.deliveryId),
    )
    expect(new Set(deliveryIds).size).toBe(10)
  })

  it('delivers v2 paints, offers, and wanted tile bytes without HTTP fallback', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveSyncMax: 2 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.liveHealthy = true
    coordinator.livePaint.mockResolvedValue({
      type: 'paint-result',
      eventId: 'ignored',
      result: 'recorded',
    })
    coordinator.liveFullTileOffer.mockImplementation(async (_server, batch) => ({
      type: 'tile-offer-result',
      response: {
        acknowledgedDeliveryIds: [],
        wanted: batch.offers.map(({ deliveryId }) => ({
          deliveryId,
          coverageToken: 'coverage',
        })),
        rejectedDeliveryIds: [],
      },
    }))
    coordinator.liveTileUpload.mockImplementation(async (_server, upload) => ({
      type: 'tile-upload-result',
      deliveryId: upload.deliveryId,
      accepted: true,
    }))
    const mutationHttp: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (
          url.includes('/telemetry/paints') ||
          url.includes('/telemetry/tiles/offers') ||
          url.includes('/telemetry/tiles/1/2/')
        )
          mutationHttp.push(url)
        if (url.includes('/telemetry/status')) return Response.json({ revision: 1, templates: [] })
        if (url.includes('/telemetry/alarms'))
          return Response.json({ version: 'a'.repeat(64), alarms: [] })
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 1,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
    })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(coordinator.liveTileUpload).toHaveBeenCalledOnce())
    expect(coordinator.livePaint).toHaveBeenCalledOnce()
    expect(mutationHttp).toEqual([])
  })

  it('does not upload v2 tile bytes after sharing is disabled', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveSyncMax: 2 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.liveHealthy = true
    let answerOffer!: (value: Awaited<ReturnType<typeof coordinator.liveFullTileOffer>>) => void
    coordinator.liveFullTileOffer.mockImplementation(
      () => new Promise((resolve) => (answerOffer = resolve)),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)
    await vi.waitFor(() => expect(coordinator.liveFullTileOffer).toHaveBeenCalledOnce())

    harness.state = { ...harness.state, shareTiles: false }
    for (const listener of harness.stateListeners) listener()
    const deliveryId = coordinator.liveFullTileOffer.mock.calls[0]?.[1].offers[0]?.deliveryId
    if (deliveryId === undefined) throw new Error('tile offer was not sent')
    answerOffer({
      type: 'tile-offer-result',
      response: {
        acknowledgedDeliveryIds: [],
        wanted: [{ deliveryId, coverageToken: 'coverage' }],
        rejectedDeliveryIds: [],
      },
    })
    await Promise.resolve()
    expect(coordinator.liveTileUpload).not.toHaveBeenCalled()
  })

  it('retries one v2 paint with the same event id after its acknowledgement is lost', async () => {
    vi.useFakeTimers()
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveSyncMax: 2 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.livePaint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementation(async (_server, event) => ({
        type: 'paint-result',
        eventId: event.eventId,
        result: 'duplicate',
      }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ revision: 1, templates: [] })
        if (url.includes('/telemetry/alarms'))
          return Response.json({ version: 'a'.repeat(64), alarms: [] })
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 1,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
    })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(coordinator.livePaint).toHaveBeenCalledTimes(4)
    const eventIds = coordinator.livePaint.mock.calls.map(([, event]) => event.eventId)
    expect(new Set(eventIds).size).toBe(1)
  })

  it('falls back to the HTTP offer when the live request disconnects', async () => {
    const liveServer = {
      ...server,
      info: { ...server.info, liveSync: 1 as const, liveTileOffers: 1 as const },
    }
    harness.state = { ...harness.state, servers: [liveServer] }
    coordinator.liveHealthy = true
    coordinator.liveTileOffer.mockResolvedValue(null)
    const httpOffers: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/tiles/offers')) {
          httpOffers.push(JSON.parse(String(init?.body)))
          return Response.json({ wanted: [], acknowledged: ['1/2'], rejected: [] })
        }
        if (url.includes('/telemetry/status')) return Response.json({ revision: 1, templates: [] })
        if (url.includes('/telemetry/alarms')) return Response.json({ alarms: [] })
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(liveServer, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(httpOffers).toHaveLength(1))
    expect(coordinator.liveTileOffer).toHaveBeenCalledOnce()
  })

  it('does not lose a distinct tile fetch while the previous offer is in flight', async () => {
    let offers = 0
    let acknowledge: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return new Promise<Response>((resolve) => {
            acknowledge = () =>
              resolve(
                Response.json({
                  wanted: [],
                  acknowledged: ['1/2'],
                  rejected: [],
                }),
              )
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(offers).toBe(1))
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)

    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(1)
    acknowledge?.()
    await vi.waitFor(() => expect(offers).toBe(2))
  })

  it('sends same-tile fetches in separate valid offer batches', async () => {
    const batches: Array<{ offers: Array<{ tile: string }> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          batches.push(JSON.parse(String(init?.body)))
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)

    await vi.waitFor(() => expect(batches).toHaveLength(2))
    expect(batches.flatMap((batch) => batch.offers).map((offer) => offer.tile)).toEqual([
      '1/2',
      '1/2',
    ])
    expect(batches.every((batch) => batch.offers.length === 1)).toBe(true)
  })

  it('preserves distinct observations while account identity is loading', async () => {
    let offers = 0
    let finishAccountLoad: (() => void) | undefined
    const accountLoad = new Promise<void>((resolve) => {
      finishAccountLoad = resolve
    })
    account.loadAccount.mockImplementation(() => accountLoad)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(0)

    finishAccountLoad?.()
    await vi.waitFor(() => expect(offers).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(2)
  })

  it('preserves a bounded-queue burst until every observation gets its first offer', async () => {
    let finishAccountLoad: (() => void) | undefined
    const accountLoad = new Promise<void>((resolve) => {
      finishAccountLoad = resolve
    })
    account.loadAccount.mockImplementation(() => accountLoad)
    const offered = new Set<string>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          for (const offer of body.offers) offered.add(offer.tile)
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    const observationCount = MAX_TILE_OFFERS + 34
    const chunks = Array.from({ length: observationCount }, (_, index) => ({
      tile: `${index}/7`,
      hash: `hash-${index}`,
    }))
    harness.serverContents?.(server, {
      nodes: [],
      templates: [{ ...template, chunks }],
    })

    harness.fetchedTile?.({ x: 0, y: 7 }, new Uint8Array([0]), 1_800_000_000)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())
    for (let index = 1; index < observationCount; index++)
      harness.fetchedTile?.({ x: index, y: 7 }, new Uint8Array([index]), 1_800_000_000 + index)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offered.size).toBe(0)

    finishAccountLoad?.()
    await vi.waitFor(() => expect(offered.size).toBe(observationCount), { timeout: 2_000 })
  })

  it('restores recent retries trimmed from a failed active batch', async () => {
    vi.useFakeTimers()
    const digestCompletions: Array<() => void> = []
    const nativeCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      subtle: {
        digest: vi.fn((_algorithm: AlgorithmIdentifier, data: BufferSource) => {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data)
          const value = bytes[0] ?? 0
          return new Promise<ArrayBuffer>((resolve) => {
            digestCompletions[value] = () => {
              const digest = new Uint8Array(32)
              digest[0] = value
              resolve(digest.buffer)
            }
          })
        }),
      },
    })
    const mirror = { ...server, url: 'https://mirror.example' }
    harness.state = { ...harness.state, servers: [server, mirror] }
    const attempts = new Map<string, Array<{ offers: Array<{ tile: string }> }>>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.includes('/telemetry/alarms')) return Response.json({ alarms: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const origin = new URL(url).origin
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          const held = attempts.get(origin) ?? []
          held.push(body)
          attempts.set(origin, held)
          if (origin === server.url && held.length === 1)
            return Response.json({ error: 'temporary' }, { status: 400 })
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    const observationCount = 34
    const contents = {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: Array.from({ length: observationCount }, (_, index) => ({
            tile: `${index}/11`,
            hash: `hash-${index}`,
          })),
        },
      ],
    }
    harness.serverContents?.(server, contents)
    harness.serverContents?.(mirror, contents)

    for (let index = 0; index < observationCount; index++) {
      const bytes = new Uint8Array(1_000_000)
      bytes[0] = index
      harness.fetchedTile?.({ x: index, y: 11 }, bytes, 1_800_000_000 + index)
    }
    expect(digestCompletions).toHaveLength(observationCount)
    for (let index = observationCount - 1; index >= 0; index--) digestCompletions[index]?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(attempts.get(server.url)).toHaveLength(1), { timeout: 2_000 })

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(attempts.get(server.url)).toHaveLength(2), { timeout: 2_000 })
    const retriedTiles = attempts.get(server.url)?.[1]?.offers.map((offer) => offer.tile) ?? []
    const expectedTiles = Array.from({ length: 32 }, (_, index) => `${index + 2}/11`)
    expect(retriedTiles).toHaveLength(expectedTiles.length)
    expect(new Set(retriedTiles)).toEqual(new Set(expectedTiles))
  })

  it('releases queued tile offers when no reporter identity is available', async () => {
    account.identity = null
    account.identityUnavailable = true
    const offered: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          offered.push(...body.offers.map((offer) => offer.tile))
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    const observationCount = MAX_TILE_OFFERS + 34
    const chunks = Array.from({ length: observationCount + 1 }, (_, index) => ({
      tile: `${index}/8`,
      hash: `hash-${index}`,
    }))
    harness.serverContents?.(server, {
      nodes: [],
      templates: [{ ...template, chunks }],
    })

    for (let index = 0; index < observationCount; index++)
      harness.fetchedTile?.({ x: index, y: 8 }, new Uint8Array([index]), 1_800_000_000 + index)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offered).toEqual([])

    account.identity = { wplaceUserId: 42, displayName: 'Mía 🎨' }
    harness.fetchedTile?.(
      { x: observationCount, y: 8 },
      new Uint8Array([observationCount]),
      1_800_000_000 + observationCount,
    )
    await vi.waitFor(() => expect(offered).toEqual([`${observationCount}/8`]))
  })

  it('retries every queued observation after a transient account lookup failure', async () => {
    account.identity = null
    const offered = new Set<string>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          for (const offer of body.offers) offered.add(offer.tile)
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    const observationCount = MAX_TILE_OFFERS + 34
    const contents = {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: Array.from({ length: observationCount }, (_, index) => ({
            tile: `${index}/10`,
            hash: `hash-${index}`,
          })),
        },
      ],
    }
    harness.serverContents?.(server, contents)

    for (let index = 0; index < observationCount; index++)
      harness.fetchedTile?.({ x: index, y: 10 }, new Uint8Array([index]), 1_800_000_000 + index)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offered.size).toBe(0)

    account.identity = { wplaceUserId: 42, displayName: 'Mía 🎨' }
    harness.serverContents?.(server, contents)
    await vi.waitFor(() => expect(offered.size).toBe(observationCount), { timeout: 2_000 })
  })

  it('preserves the account retry delay when new tile observations arrive', async () => {
    vi.useFakeTimers()
    account.identity = null
    const offered: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          const body = JSON.parse(String(init?.body)) as { offers: Array<{ tile: string }> }
          offered.push(...body.offers.map((offer) => offer.tile))
          return Response.json({
            wanted: [],
            acknowledged: body.offers.map((offer) => offer.tile),
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [
            { tile: '1/12', hash: 'hash-1' },
            { tile: '2/12', hash: 'hash-2' },
          ],
        },
      ],
    })

    harness.fetchedTile?.({ x: 1, y: 12 }, new Uint8Array([1]), 1_800_000_000)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())

    harness.fetchedTile?.({ x: 2, y: 12 }, new Uint8Array([2]), 1_800_000_001)
    await vi.advanceTimersByTimeAsync(250)
    expect(account.loadAccount).toHaveBeenCalledOnce()
    expect(offered).toEqual([])

    account.identity = { wplaceUserId: 42, displayName: 'Mía 🎨' }
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(offered).toEqual(['1/12', '2/12']))
  })

  it('does not let a retired account-load completion clear its replacement fence', async () => {
    let offers = 0
    let finishAccountLoad: (() => void) | undefined
    const accountLoad = new Promise<void>((resolve) => {
      finishAccountLoad = resolve
    })
    account.loadAccount.mockImplementation(() => accountLoad)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledOnce())

    const replacement = { ...server }
    harness.retiredServers.add(server)
    harness.state = { ...harness.state, servers: [replacement] }
    for (const listener of harness.stateListeners) listener()
    harness.serverContents?.(replacement, { nodes: [], templates: [template] })
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(account.loadAccount).toHaveBeenCalledOnce()
    expect(offers).toBe(0)

    finishAccountLoad?.()
    await new Promise((resolve) => setTimeout(resolve, 25))
    harness.serverContents?.(replacement, { nodes: [], templates: [template] })
    await vi.waitFor(() => expect(account.loadAccount).toHaveBeenCalledTimes(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(offers).toBe(2), { timeout: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(2)
  })

  it('retries ambiguous old-server responses and explicit server requests', async () => {
    let mode: 'old' | 'requested' = 'old'
    let offers = 0
    let uploads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return mode === 'old'
            ? Response.json({ wanted: [] })
            : Response.json({
                wanted: ['1/2'],
                acknowledged: [],
                rejected: [],
              })
        }
        if (url.includes('/telemetry/tiles/1/2/')) {
          uploads++
          return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(offers).toBe(1))
    await vi.waitFor(() =>
      expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 0),
    )
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    await vi.waitFor(() => expect(offers).toBe(2), { timeout: 2_000 })
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-retried', 1)
    expect(
      debug.count.mock.calls.filter(([metric]) => metric === 'telemetry:tile-offers-retried'),
    ).toHaveLength(1)

    mode = 'requested'
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_002)
    await vi.waitFor(() => expect(uploads).toBe(3))
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_003)
    await vi.waitFor(() => expect(offers).toBe(4))
    await vi.waitFor(() => expect(uploads).toBe(6))
  })

  it('suppresses replay of the same rejected observation until coverage changes', async () => {
    let offers = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return Response.json({
            wanted: [],
            acknowledged: [],
            rejected: ['1/2'],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      revision: 'manifest-1',
      nodes: [],
      templates: [template],
    })

    const bytes = new Uint8Array([1, 2, 3])
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_000)
    await vi.waitFor(() => expect(offers).toBe(1))
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-rejected', 1)

    harness.serverContents?.(server, {
      revision: 'manifest-1',
      nodes: [],
      templates: [{ ...template }],
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-avoided', 1)

    harness.serverContents?.(server, {
      revision: 'manifest-2',
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [...template.chunks, { tile: '2/2', hash: 'other' }],
        },
      ],
    })
    await vi.waitFor(() => expect(offers).toBe(2))
  })

  it('reoffers a late rejection from superseded manifest coverage', async () => {
    let offers = 0
    let rejectFirst: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          if (offers === 1)
            return new Promise<Response>((resolve) => {
              rejectFirst = () =>
                resolve(
                  Response.json({
                    wanted: [],
                    acknowledged: [],
                    rejected: ['1/2'],
                  }),
                )
            })
          return Response.json({
            wanted: [],
            acknowledged: ['1/2'],
            rejected: [],
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      revision: 'manifest-1',
      nodes: [],
      templates: [template],
    })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)
    await vi.waitFor(() => expect(offers).toBe(1))

    harness.serverContents?.(server, {
      revision: 'manifest-2',
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [...template.chunks, { tile: '2/2', hash: 'other' }],
        },
      ],
    })
    rejectFirst?.()

    await vi.waitFor(() => expect(offers).toBe(2))
  })

  it('strips out-of-scope tiles from paint reports', async () => {
    const reports: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/paints')) reports.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 1,
      tiles: [
        { x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } },
        { x: 9, y: 9, pixels: { x: [6], y: [7], colors: [8] } },
      ],
    })

    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({
      wplaceUserId: 42,
      displayName: 'Mía 🎨',
      season: 0,
      painted: null,
      tiles: [{ x: 1, y: 2 }],
    })
  })

  it('reports every accepted paint callback even when payloads and timestamps match', async () => {
    const reports: Array<{ eventId: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/paints')) reports.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    const paint = {
      season: 0,
      observedAt: 1_800_000_000,
      painted: 1,
      tiles: [{ x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } }],
    }

    harness.acceptedPaint?.(paint)
    harness.acceptedPaint?.(paint)

    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(new Set(reports.map((report) => report.eventId)).size).toBe(2)
  })

  it('replays failed paint reports when tile sharing is disabled', async () => {
    let attempts = 0
    const bodies: string[] = []
    let settleFirstAttempt: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/paints')) {
          attempts++
          bodies.push(String(init?.body))
          if (attempts === 1)
            return new Promise<Response>((resolve) => {
              settleFirstAttempt = resolve
            })
          return new Response(null, { status: attempts <= 3 ? 503 : 204 })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [...template.chunks, { tile: '2/2', hash: 'other' }],
        },
      ],
    })
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 2,
      tiles: [
        { x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } },
        { x: 2, y: 2, pixels: { x: [6], y: [7], colors: [8] } },
      ],
    })
    await vi.waitFor(() => expect(settleFirstAttempt).toBeDefined())

    harness.state = { ...harness.state, shareTiles: false }
    for (const listener of harness.stateListeners) listener()
    harness.serverContents?.(server, { nodes: [], templates: [template] })
    settleFirstAttempt?.(new Response(null, { status: 503 }))

    await vi.waitFor(() => expect(attempts).toBe(4))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(attempts).toBe(4)
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({
      painted: 2,
      tiles: [
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ],
    })
  })

  it('retries one immutable paint event without changing count, order, or attribution', async () => {
    const paintAttempts: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/paints')) {
          paintAttempts.push(String(init?.body))
          return new Response(null, {
            status: paintAttempts.length < 3 ? 503 : 204,
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, {
      nodes: [],
      templates: [
        {
          ...template,
          chunks: [...template.chunks, { tile: '2/2', hash: 'other' }],
        },
      ],
    })
    harness.acceptedPaint?.({
      season: 0,
      observedAt: 1_800_000_000,
      painted: 2,
      tiles: [
        { x: 2, y: 2, pixels: { x: [8], y: [9], colors: [10] } },
        { x: 1, y: 2, pixels: { x: [3], y: [4], colors: [5] } },
      ],
    })

    await vi.waitFor(() => expect(paintAttempts).toHaveLength(3))
    expect(new Set(paintAttempts).size).toBe(1)
    const event = JSON.parse(paintAttempts[0] ?? '{}') as {
      eventId: string
      wplaceUserId: number
      displayName: string
      painted: number
      tiles: Array<{ x: number; y: number }>
    }
    expect(event).toMatchObject({
      wplaceUserId: 42,
      displayName: 'Mía 🎨',
      painted: 2,
      tiles: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
    })
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
