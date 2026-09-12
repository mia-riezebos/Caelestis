// @vitest-environment happy-dom

import {
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_VIEWPORT_MIN_MS,
  TILE_SIZE,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TileFrame } from './tile-transform.js'

const harness = vi.hoisted(() => ({
  state: {
    servers: [] as object[],
    sharePresence: true,
    showPresence: true,
  },
  listener: null as null | (() => void),
  identity: { wplaceUserId: 7, displayName: 'Mia' } as {
    wplaceUserId: number
    displayName: string
  } | null,
  draftedTiles: [] as { x: number; y: number }[],
  draftedOffsets: new Map<string, number[]>(),
  mutations: [] as { url: string; init: RequestInit }[],
}))

vi.mock('./state.js', () => ({
  getState: () => harness.state,
  isCurrentServerConnection: (server: object) => harness.state.servers.includes(server),
  serverConnectionIdentity: (server: object) => server,
  onStateChange: (listener: () => void) => {
    harness.listener = listener
  },
  activeServerToken: (server: { token: string | null }) => server.token,
}))
vi.mock('./wplace-account.js', () => ({
  accountIdentity: () => harness.identity,
  loadAccount: () => Promise.resolve(),
}))
vi.mock('./tile-transform.js', () => ({
  draftedTiles: () => harness.draftedTiles,
  draftedPixelOffsets: (tile: { x: number; y: number }) =>
    harness.draftedOffsets.get(`${tile.x}/${tile.y}`) ?? [],
}))
vi.mock('./server-transport.js', () => ({
  requestServerMutation: (url: string, init: RequestInit) => {
    harness.mutations.push({ url, init })
    return Promise.resolve({ response: new Response(null, { status: 200 }), body: {} })
  },
}))
vi.mock('./client-metrics.js', () => ({ userscriptVersion: '0.0.0-test' }))
vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))

class FakeWebSocket extends EventTarget {
  static readonly instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  static readonly CLOSING = 2
  readonly url: string
  readonly protocols: string[]
  readonly sent: string[] = []
  protocol = ''
  readyState = 0

  constructor(url: string | URL, protocols: string | string[]) {
    super()
    this.url = String(url)
    this.protocols = typeof protocols === 'string' ? [protocols] : protocols
    FakeWebSocket.instances.push(this)
  }

  open(protocol = PRESENCE_PROTOCOL_V1): void {
    this.protocol = protocol
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  events(): Record<string, unknown>[] {
    return this.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
  }
}

const server = {
  url: 'https://example.test',
  info: { id: 'server', name: 'Example', auth: 'access_token' as const, presence: 1 as const },
  token: 'secret-token',
  status: 'connected' as const,
  isAdmin: false,
  season: 3,
}

const frame = (quads: TileFrame['quads'], width = 800, height = 600): TileFrame => ({
  canvas: { width, height } as HTMLCanvasElement,
  quads,
})

const tileAt = (x: number, y: number, screenX = 0, screenY = 0) => ({
  tile: { x, y },
  x: screenX,
  y: screenY,
  width: TILE_SIZE,
  height: TILE_SIZE,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances.length = 0
  harness.state.servers = [server]
  harness.state.sharePresence = true
  harness.identity = { wplaceUserId: 7, displayName: 'Mia' }
  harness.draftedTiles = []
  harness.draftedOffsets = new Map()
  harness.mutations = []
})

afterEach(async () => {
  const { resetPresence } = await import('./presence-client.js')
  resetPresence()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const connect = async () => {
  const client = await import('./presence-client.js')
  client.installPresence()
  const socket = FakeWebSocket.instances[0]
  if (socket === undefined) throw new Error('no socket opened')
  socket.open()
  return { client, socket }
}

describe('presence client', () => {
  it('opens one socket per server with the painter identity and credential protocol', async () => {
    const { socket } = await connect()
    const url = new URL(socket.url)
    expect(url.protocol).toBe('wss:')
    expect(url.pathname.endsWith('/telemetry/presence')).toBe(true)
    expect(url.searchParams.get('season')).toBe('3')
    expect(url.searchParams.get('surface')).toBe('world')
    expect(url.searchParams.get('painterId')).toBe('7')
    expect(url.searchParams.get('painterName')).toBe('Mia')
    expect(socket.protocols[0]).toBe(PRESENCE_PROTOCOL_V1)
    expect(socket.protocols[1]).toMatch(/^caelestis\.auth\.b64\./)
  })

  it('does not connect to a server without presence support', async () => {
    harness.state.servers = [{ ...server, info: { ...server.info, presence: undefined } }]
    const client = await import('./presence-client.js')
    client.installPresence()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('publishes the first viewport at once and later ones at most every two seconds', async () => {
    const { client, socket } = await connect()
    client.observePresenceFrame(frame([tileAt(10, 20)]))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.events()).toEqual([
      { type: 'presence-update', viewport: { x: 10_000, y: 20_000, w: 800, h: 600 }, draft: null },
    ])
    // A pan a few frames later waits for the window.
    client.observePresenceFrame(frame([tileAt(10, 20, -100, 0)]))
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.events()).toHaveLength(1)
    client.observePresenceFrame(frame([tileAt(10, 20, -300, 0)]))
    await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
    expect(socket.events()).toHaveLength(2)
    expect(socket.events()[1]).toEqual({
      type: 'presence-update',
      viewport: { x: 10_296, y: 20_000, w: 808, h: 600 },
    })
  })

  it('does not resend an unchanged viewport', async () => {
    const { client, socket } = await connect()
    client.observePresenceFrame(frame([tileAt(10, 20)]))
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 10; i++) {
      client.observePresenceFrame(frame([tileAt(10, 20)]))
      await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
    }
    expect(socket.events()).toHaveLength(1)
  })

  it('publishes a draft mask and clears it immediately when the draft goes', async () => {
    const { client, socket } = await connect()
    harness.draftedTiles = [{ x: 1, y: 1 }]
    harness.draftedOffsets.set('1/1', [0, 1])
    client.observePresenceFrame(frame([tileAt(1, 1)]))
    await vi.advanceTimersByTimeAsync(0)
    const first = socket.events()[0] as { draft: { rect: unknown; pixels: number; mask: string } }
    expect(first.draft.rect).toEqual({ x: TILE_SIZE, y: TILE_SIZE, w: 2, h: 1 })
    expect(first.draft.pixels).toBe(2)
    expect(typeof first.draft.mask).toBe('string')

    harness.draftedTiles = []
    await vi.advanceTimersByTimeAsync(PRESENCE_DRAFT_MIN_MS)
    client.observePresenceFrame(frame([tileAt(1, 1)]))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.events().at(-1)).toEqual({ type: 'presence-update', draft: null })
  })

  it('heartbeats with the full state after thirty quiet seconds', async () => {
    const { client, socket } = await connect()
    client.observePresenceFrame(frame([tileAt(10, 20)]))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(socket.events().at(-1)).toEqual({ type: 'presence-heartbeat' })
  })

  it('withholds the viewport while sharing is off and clears it when switched off', async () => {
    const { client, socket } = await connect()
    client.observePresenceFrame(frame([tileAt(10, 20)]))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.events()).toHaveLength(1)
    harness.state.sharePresence = false
    harness.listener?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.events().at(-1)).toEqual({ type: 'presence-update', viewport: null })
  })

  it('keeps peers and regions from the server and hides its own session', async () => {
    const { client, socket } = await connect()
    const changes = vi.fn()
    client.onPresenceChange(changes)
    const peer = {
      sessionId: 'b',
      painter: { wplaceUserId: 9, displayName: 'Sam' },
      viewport: { x: 0, y: 0, w: 100, h: 100 },
      draft: null,
    }
    socket.receive({
      type: 'presence-ready',
      sessionId: 'a',
      online: 2,
      peers: [{ ...peer, sessionId: 'a' }, peer],
      regions: [],
    })
    expect(client.presenceView()).toMatchObject({ online: 2, connected: true, peers: [peer] })
    socket.receive({ type: 'presence-delta', online: 3, upsert: [], remove: ['b'] })
    expect(client.presenceView().peers).toEqual([])
    expect(client.presenceView().online).toBe(3)
    const region = {
      id: 'r1',
      season: 3,
      surface: { kind: 'world', allianceId: null },
      templateId: '0192e7c0-0000-7000-8000-000000000001',
      claimant: { wplaceUserId: 9, displayName: 'Sam' },
      document: {
        items: [{ id: 'a', op: 'add', shape: { kind: 'rectangle', x: 5, y: 5, w: 10, h: 10 } }],
      },
      rect: { x: 5, y: 5, w: 10, h: 10 },
      label: '',
      createdAt: 1,
    }
    socket.receive({ type: 'regions', regions: [region, { bogus: true }] })
    expect(client.presenceView().regions).toEqual([region])
    expect(changes).toHaveBeenCalled()
  })

  it('drops the socket on a malformed event and reconnects', async () => {
    const { socket } = await connect()
    socket.receive({ type: 'presence-ready', sessionId: 42 })
    expect(socket.readyState).toBe(3)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('sends region claims over HTTP with the bearer token', async () => {
    const { client } = await connect()
    const error = await client.claimRegion(server, '0192e7c0-0000-7000-8000-000000000002', {
      templateId: '0192e7c0-0000-7000-8000-000000000001',
      document: {
        items: [{ id: 'a', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 10, h: 10 } }],
      },
      label: '',
      actor: { wplaceUserId: 7, displayName: 'Mia' },
    })
    expect(error).toBeNull()
    const mutation = harness.mutations[0]
    expect(mutation?.init.method).toBe('PUT')
    expect(new URL(mutation?.url ?? '').pathname).toMatch(
      /\/work\/regions\/0192e7c0-0000-7000-8000-000000000002$/,
    )
    expect(new Headers(mutation?.init.headers).get('authorization')).toBe('Bearer secret-token')
  })
})
