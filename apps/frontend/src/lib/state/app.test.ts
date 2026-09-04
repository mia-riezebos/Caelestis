// @vitest-environment happy-dom
import { millis } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppBootstrap, AppState } from './app.svelte.js'

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  protocol: string
  readyState = 0

  constructor(
    readonly url: URL,
    readonly protocols: readonly string[],
  ) {
    super()
    this.protocol = protocols[0] ?? ''
    FakeWebSocket.instances.push(this)
  }

  open(protocol = this.protocol): void {
    this.protocol = protocol
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
})

afterEach(() => vi.unstubAllGlobals())

const liveServer = {
  id: '01890f3e-7b2c-7abc-8def-000000000001',
  name: 'Caelestis',
  auth: 'access_token' as const,
  liveSync: 1 as const,
  liveSyncMax: 2 as const,
}

const manifest = {
  version: 'a'.repeat(64),
  season: 7,
  server: {
    id: liveServer.id,
    name: liveServer.name,
    auth: liveServer.auth,
  },
  nodes: [],
  templates: [],
  tiles: [],
}

const bootstrap: AppBootstrap = {
  server: liveServer,
  manifest,
  statuses: [],
  statusRevision: 1,
  alarms: [],
  alarmsVersion: 'b'.repeat(64),
  canvas: [],
  needsRecovery: false,
  error: null,
}

describe('frontend live state', () => {
  it('hydrates shared and dashboard state from one proxied socket', () => {
    const app = new AppState(bootstrap)
    const dashboard = vi.fn()
    app.subscribeDashboard([], 1_800_000_000, dashboard)
    app.startLive()
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    socket?.receive({
      type: 'status-snapshot',
      status: {
        revision: 2,
        templates: [
          {
            templateId: '01890f3e-7b2c-7abc-8def-000000000002',
            correct: 1,
            wrong: 0,
            blank: 0,
            total: 1,
            observedAt: millis(1_800_000_000_000),
          },
        ],
      },
    })
    const subscription = socket?.sent
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === 'dashboard-subscribe')
    const subscriptionId = (subscription?.subscription as { subscriptionId?: string })
      ?.subscriptionId
    socket?.receive({
      type: 'dashboard-snapshot',
      subscriptionId,
      contributions: { days: [] },
      leaderboard: { entries: [] },
    })

    expect(app.statuses.size).toBe(1)
    expect(dashboard).toHaveBeenCalledWith({
      contributions: { days: [] },
      leaderboard: { entries: [] },
    })
    expect(socket?.url.pathname).toBe('/api/v1/telemetry/live')
  })

  it('advertises cleared projections when recovery reads fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/server')) return Response.json(liveServer)
        if (url.endsWith('/manifest')) return Response.json(manifest)
        if (url.includes('/telemetry/status') || url.includes('/telemetry/alarms'))
          return Response.json({ error: 'unavailable' }, { status: 503 })
        if (url.includes('/telemetry/canvas')) return Response.json({ tiles: [] })
        if (url.includes('/admin/nodes')) return new Response(null, { status: 403 })
        throw new Error(`unexpected request: ${url}`)
      }),
    )
    const app = new AppState(bootstrap)

    await app.load()
    app.startLive()
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    const stateVector = socket?.sent
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === 'state-vector')

    expect(stateVector).toMatchObject({
      revision: null,
      projections: [
        { resource: 'world-manifest', version: manifest.version },
        { resource: 'telemetry-alarms', version: null },
      ],
    })
  })

  it('keeps dashboard polling when an advertised v2 server negotiates v1', () => {
    const app = new AppState(bootstrap)
    app.subscribeDashboard([], 1_800_000_000, vi.fn())
    app.startLive()
    const socket = FakeWebSocket.instances[0]

    socket?.open('caelestis.live.v1')

    expect(app.liveProtocol).toBe(1)
    expect(socket?.sent).toEqual([])
  })
})
