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
  reads: [] as { url: string; init: RequestInit }[],
  /** Presence headcount per server origin; a missing entry answers 404. */
  online: new Map<string, number>(),
  /** Region claims per server origin, served to servers without the socket. */
  regions: new Map<string, unknown[]>(),
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
  requestServerMetadata: (url: string, init: RequestInit) => {
    harness.reads.push({ url, init })
    const { origin, pathname } = new URL(url)
    if (pathname.endsWith('/telemetry/presence/online')) {
      const online = harness.online.get(origin)
      return Promise.resolve(
        online === undefined
          ? { response: new Response(null, { status: 404 }), body: { error: 'not found' } }
          : { response: new Response(null, { status: 200 }), body: { online } },
      )
    }
    return Promise.resolve({
      response: new Response(null, { status: 200 }),
      body: { regions: harness.regions.get(origin) ?? [] },
    })
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
  harness.reads = []
  harness.online = new Map([[server.url, 1]])
  harness.regions = new Map()
})

/** Let the election's probes resolve; they are plain promises, not timers. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

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
  await settle()
  const socket = FakeWebSocket.instances[0]
  if (socket === undefined) throw new Error('no socket opened')
  socket.open()
  return { client, socket }
}

describe('presence client', () => {
  it('opens one socket with the painter identity and credential protocol', async () => {
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
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(harness.reads).toHaveLength(0)
  })

  it('opens a single socket on the server with the fewest painters online', async () => {
    const busy = {
      ...server,
      url: 'https://busy.test',
      info: { ...server.info, id: 'a-busy' },
    }
    const quiet = {
      ...server,
      url: 'https://quiet.test',
      info: { ...server.info, id: 'b-quiet' },
    }
    harness.state.servers = [busy, quiet]
    harness.online = new Map([
      [busy.url, 40],
      [quiet.url, 3],
    ])
    const claim = {
      id: 'r-busy',
      season: 3,
      surface: { kind: 'world', allianceId: null },
      templateId: null,
      claimant: { wplaceUserId: 9, displayName: 'Sam' },
      document: {
        items: [
          {
            id: 'a',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 5, y: 5, w: 10, h: 10 },
          },
        ],
      },
      rect: { x: 5, y: 5, w: 10, h: 10 },
      label: '',
      createdAt: 1,
    }
    harness.regions.set(busy.url, [claim])
    const client = await import('./presence-client.js')
    client.installPresence()
    await settle()
    // Both were asked, once each, with the bearer token; only the quiet one got the socket.
    const probes = harness.reads.filter((read) => read.url.includes('/telemetry/presence/online'))
    expect(probes.map((read) => new URL(read.url).origin).sort()).toEqual([busy.url, quiet.url])
    expect(new Headers(probes[0]?.init.headers).get('authorization')).toBe('Bearer secret-token')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url.startsWith('wss://quiet.test')).toBe(true)
    FakeWebSocket.instances[0]?.open()
    // The busy server still contributes its claims, fetched over HTTP.
    await settle()
    expect(client.presenceView().regions).toEqual([claim])
    expect(client.presenceServers().map((held) => held.url)).toEqual([quiet.url, busy.url])
    expect(client.presenceLiveServer()?.url).toBe(quiet.url)
    // Claims on the busy server are saved over HTTP and its list is fetched again straight away.
    const before = harness.reads.length
    await client.claimRegion(busy, '0192e7c0-0000-7000-8000-000000000002', {
      templateId: null,
      document: claim.document,
      label: '',
      actor: { wplaceUserId: 7, displayName: 'Mia' },
    })
    await settle()
    expect(harness.reads.slice(before).some((read) => read.url.includes('/work/regions'))).toBe(
      true,
    )
  })

  it('breaks a headcount tie by server id and treats an unanswered probe as the busiest', async () => {
    const zed = { ...server, url: 'https://zed.test', info: { ...server.info, id: 'z' } }
    const amy = { ...server, url: 'https://amy.test', info: { ...server.info, id: 'a' } }
    const mute = { ...server, url: 'https://mute.test', info: { ...server.info, id: '0' } }
    harness.state.servers = [zed, amy, mute]
    harness.online = new Map([
      [zed.url, 5],
      [amy.url, 5],
    ])
    const client = await import('./presence-client.js')
    client.installPresence()
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url.startsWith('wss://amy.test')).toBe(true)
  })

  it('keeps the open socket where it is when a quieter server appears', async () => {
    const { socket } = await connect()
    const quiet = { ...server, url: 'https://quiet.test', info: { ...server.info, id: 'b' } }
    harness.online.set(quiet.url, 0)
    harness.state.servers = [server, quiet]
    harness.listener?.()
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(1)
  })

  it('publishes the first viewport at once, then at most every quarter second while moving, and the last one after', async () => {
    const { client, socket } = await connect()
    client.observePresenceFrame(frame([tileAt(10, 20)]))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.events()).toEqual([
      { type: 'presence-update', viewport: { x: 10_000, y: 20_000, w: 800, h: 600 }, draft: null },
    ])
    // A pan a few frames later waits for the window.
    client.observePresenceFrame(frame([tileAt(10, 20, -100, 0)]))
    await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS / 2)
    expect(socket.events()).toHaveLength(1)
    client.observePresenceFrame(frame([tileAt(10, 20, -300, 0)]))
    await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
    expect(socket.events()).toHaveLength(2)
    expect(socket.events()[1]).toEqual({
      type: 'presence-update',
      viewport: { x: 10_296, y: 20_000, w: 808, h: 600 },
    })
    // Movement stops: the last position lands within one window, and nothing follows on its own.
    client.observePresenceFrame(frame([tileAt(10, 20, -350, 0)]))
    await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
    expect(socket.events()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS * 20)
    expect(socket.events()).toHaveLength(3)
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
    await settle()
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
