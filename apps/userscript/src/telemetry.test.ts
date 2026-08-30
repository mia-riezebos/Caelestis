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
  state: {
    shareTiles: true,
    reportPaints: true,
    servers: [] as unknown[],
    hiddenScopes: [] as string[],
  },
}))

const coordinator = vi.hoisted(() => ({
  snapshots: [] as unknown[],
  resources: new Map<
    string,
    {
      refresh: (server: unknown, reason: 'connect' | 'manifest-applied') => Promise<unknown>
    }
  >(),
}))

const debug = vi.hoisted(() => ({ count: vi.fn(), warn: vi.fn() }))

vi.mock('./debug.js', () => debug)
vi.mock('./state.js', () => ({
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
  getState: () => harness.state,
  isCurrentServerConnection: () => true,
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
  serverSyncRevision: () => undefined,
  registerServerSyncResource: (resource: {
    id: string
    refresh: (server: unknown, reason: 'connect' | 'manifest-applied') => Promise<unknown>
  }) => {
    coordinator.resources.set(resource.id, resource)
    queueMicrotask(() => {
      for (const server of harness.state.servers) void resource.refresh(server, 'connect')
    })
  },
  requestServerSync: (reason: 'connect' | 'manifest-applied', resourceId?: string) => {
    queueMicrotask(() => {
      for (const [id, resource] of coordinator.resources) {
        if (resourceId !== undefined && resourceId !== id) continue
        for (const server of harness.state.servers) void resource.refresh(server, reason)
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
  accountIdentity: () => ({ wplaceUserId: 42, displayName: 'Mía 🎨' }),
  loadAccount: vi.fn(async () => undefined),
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
  vi.resetModules()
  vi.clearAllMocks()
  harness.serverContents = null
  harness.fetchedTile = null
  harness.tileInterest = null
  harness.acceptedPaint = null
  harness.stateListeners = []
  coordinator.resources.clear()
  coordinator.snapshots = []
  harness.state = { shareTiles: true, reportPaints: true, servers: [server], hiddenScopes: [] }
})

afterEach(() => {
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
    await expect(resource?.refresh(server, 'connect')).resolves.toEqual({ status: 'skipped' })
    expect(coordinator.snapshots).toEqual([
      {
        status: 'unchanged',
        revision: '12',
      },
    ])
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

    harness.serverContents?.(server, { nodes: [], templates: [{ ...template }] })
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
          return Response.json({ wanted: ['1/2'] })
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
      { index: 0, completed: 1, mismatched: 0, unpainted: 0, known: 1, total: 1 },
      { index: 1, completed: 0, mismatched: 1, unpainted: 0, known: 1, total: 1 },
      { index: 2, completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
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

  it('reconciles when a successful wanted upload omits its committed status delta', async () => {
    let offered = false
    let statusReadsAfterOffer = 0
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
        if (url.includes('/telemetry/tiles/1/2/')) return Response.json({})
        return new Response(null, { status: 204 })
      }),
    )
    const { installTelemetry } = await import('./telemetry.js')
    installTelemetry()
    harness.serverContents?.(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(statusReadsAfterOffer).toBe(1))
  })

  it('suppresses an explicitly acknowledged duplicate and exposes offer metrics', async () => {
    const offers: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers.push(JSON.parse(String(init?.body)))
          return Response.json({ wanted: [], acknowledged: ['1/2'], rejected: [] })
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
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(offers).toHaveLength(1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-requested', 1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-accepted', 1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-avoided', 1)
  })

  it('does not queue an identical observation while its first offer is in flight', async () => {
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
              resolve(Response.json({ wanted: [], acknowledged: ['1/2'], rejected: [] }))
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
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(1)

    acknowledge?.()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(1)
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
            : Response.json({ wanted: ['1/2'], acknowledged: [], rejected: [] })
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
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await vi.waitFor(() => expect(offers).toBe(2))

    mode = 'requested'
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_002)
    await vi.waitFor(() => expect(uploads).toBe(3))
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_003)
    await vi.waitFor(() => expect(offers).toBe(4))
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-retried', 1)
  })

  it('suppresses an explicit rejection until its acknowledgement expires', async () => {
    let offers = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/telemetry/status')) return Response.json({ templates: [] })
        if (url.endsWith('/telemetry/tiles/offers')) {
          offers++
          return Response.json({ wanted: [], acknowledged: [], rejected: ['1/2'] })
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
    harness.fetchedTile?.({ x: 1, y: 2 }, bytes, 1_800_000_001)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(offers).toBe(1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-rejected', 1)
    expect(debug.count).toHaveBeenCalledWith('telemetry:tile-offers-avoided', 1)
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
})
