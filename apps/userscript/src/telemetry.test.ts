import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from './server-cache.js'
import type { ConnectedServer } from './state.js'

const harness = vi.hoisted(() => ({
  serverContents: [] as Array<(server: unknown, contents: unknown) => void>,
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

vi.mock('./debug.js', () => ({ warn: vi.fn() }))
vi.mock('./state.js', () => ({
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
  getState: () => harness.state,
  isCurrentServerConnection: () => true,
  sameServerConnection: () => true,
  onServerContents: (listener: (server: unknown, contents: unknown) => void) => {
    harness.serverContents.push(listener)
    return vi.fn()
  },
  onStateChange: (listener: () => void) => {
    harness.stateListeners.push(listener)
    return vi.fn()
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
  harness.serverContents = []
  harness.fetchedTile = null
  harness.tileInterest = null
  harness.acceptedPaint = null
  harness.stateListeners = []
  harness.state = { shareTiles: true, reportPaints: true, servers: [server], hiddenScopes: [] }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const startTelemetry = async (): Promise<typeof import('./telemetry.js')> => {
  const telemetry = await import('./telemetry.js')
  telemetry.installTelemetry()
  const { installServerSyncCoordinator } = await import('./server-sync-coordinator.js')
  installServerSyncCoordinator()
  return telemetry
}

describe('server telemetry client', () => {
  it('keeps anonymous status polling CORS-simple while attributing it in the query', async () => {
    const openServer: ConnectedServer = {
      ...server,
      info: { id: 'server', name: 'Templates', auth: 'none' },
      token: null,
      tokenUsable: false,
    }
    harness.state = { ...harness.state, servers: [openServer] }
    const requests: Array<{ input: string; init: RequestInit | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init })
        return Response.json({ templates: [] })
      }),
    )

    await startTelemetry()

    await vi.waitFor(() =>
      expect(requests.some(({ input }) => input.includes('/telemetry/status'))).toBe(true),
    )
    const status = requests.find(({ input }) => input.includes('/telemetry/status'))
    const url = new URL(status?.input ?? 'https://invalid.example')
    expect(url.searchParams.get('__caelestis_client')).toBe('userscript')
    expect(url.searchParams.get('__caelestis_sync_mode')).toBe('recovery')
    expect(url.searchParams.get('__caelestis_sync_reason')).toBe('connect')
    const headers = new Headers(status?.init?.headers)
    expect(headers.get('authorization')).toBeNull()
    expect([...headers.keys()].some((name) => name.startsWith('x-caelestis-'))).toBe(false)
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
    const { onServerAlarmChange, serverAlarmFor } = await import('./telemetry.js')
    const changed = vi.fn()
    onServerAlarmChange(changed)
    await startTelemetry()
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })

    await vi.waitFor(() =>
      expect(serverAlarmFor(server, template)).toMatchObject({
        kind: 'regression',
        pixelsLost: 12,
      }),
    )

    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [{ ...template }] })
    expect(serverAlarmFor(server, template)).toBeNull()
    await vi.waitFor(() => expect(serverAlarmFor(server, template)?.id).toBeDefined())

    const unpublished = { ...template, published: false }
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [unpublished] })
    await vi.waitFor(() => expect(serverAlarmFor(server, unpublished)?.id).toBeDefined())

    harness.state = {
      ...harness.state,
      hiddenScopes: [`srv:${encodeURIComponent(server.url)}:${template.id}`],
    }
    for (const listener of harness.stateListeners) listener()
    expect(serverAlarmFor(server, template)).toBeNull()
    expect(changed).toHaveBeenCalled()
  })

  it('reads tile bodies only while a connected server may want them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ templates: [] })),
    )
    await startTelemetry()

    expect(harness.tileInterest?.({ x: 1, y: 2 })).toBe(true)
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })
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
    await startTelemetry()

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

    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })

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
    const { serverColourProgressFor, serverProgressFor } = await startTelemetry()
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })

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

  it('refreshes progress when an offer records a blob the server already has', async () => {
    let offered = false
    let statusReadsAfterOffer = 0
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/telemetry/status')) {
          if (!offered) return Response.json({ templates: [] })
          statusReadsAfterOffer += 1
          return Response.json({
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
          })
        }
        if (url.endsWith('/telemetry/tiles/offers')) {
          offered = true
          return Response.json({ wanted: [] })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const { serverProgressFor } = await startTelemetry()
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })

    harness.fetchedTile?.({ x: 1, y: 2 }, new Uint8Array([1, 2, 3]), 1_800_000_000)

    await vi.waitFor(() => expect(statusReadsAfterOffer).toBe(1))
    expect(requests.some((url) => url.includes('/telemetry/tiles/1/2/'))).toBe(false)
    expect(serverProgressFor(server, template)).toEqual({
      completed: 1,
      mismatched: 1,
      unpainted: 1,
      known: 3,
      total: 3,
    })
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
    await startTelemetry()
    for (const listener of harness.serverContents)
      listener(server, { nodes: [], templates: [template] })
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
