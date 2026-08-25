import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from './server-cache.js'
import type { ConnectedServer } from './state.js'

const harness = vi.hoisted(() => ({
  serverContents: null as ((server: unknown, contents: unknown) => void) | null,
  fetchedTile: null as
    | ((tile: { x: number; y: number }, bytes: Uint8Array, observedAt: number) => void)
    | null,
  acceptedPaint: null as ((paint: unknown) => void) | null,
  stateListeners: [] as Array<() => void>,
  state: {
    shareTiles: true,
    reportPaints: true,
    servers: [] as unknown[],
  },
}))

vi.mock('./debug.js', () => ({ warn: vi.fn() }))
vi.mock('./state.js', () => ({
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
  getState: () => harness.state,
  isCurrentServerConnection: () => true,
  onServerContents: (listener: (server: unknown, contents: unknown) => void) => {
    harness.serverContents = listener
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
  ) => {
    harness.fetchedTile = listener
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
  season: 1,
}

const template: ServerTemplate = {
  id: 'template',
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
  harness.acceptedPaint = null
  harness.stateListeners = []
  harness.state = { shareTiles: true, reportPaints: true, servers: [server] }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server telemetry client', () => {
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
      season: 1,
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
      season: 1,
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
      season: 1,
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
      season: 1,
      painted: null,
      tiles: [{ x: 1, y: 2 }],
    })
  })
})
