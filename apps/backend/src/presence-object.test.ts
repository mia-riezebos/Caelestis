import {
  decodePresenceDraftMask,
  MAX_PRESENCE_MESSAGE_CODE_UNITS,
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_PRESENCE_PEERS,
  MAX_PRESENCE_SUBSCRIBERS,
  MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT,
  millis,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_STALE_MS,
  PRESENCE_TICK_MS,
  type PresenceServerEvent,
  type RegionClaim,
  type RegionDocument,
  type RegionShape,
  regionShapeBounds,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { PresenceServerEvent as PresenceServerEventSchema } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import { PresenceObject } from './presence-object.js'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

class Socket {
  readyState = 1
  private data: unknown
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
  })
  serializeAttachment(data: unknown) {
    this.data = structuredClone(data)
  }
  deserializeAttachment() {
    return this.data
  }
  events(): PresenceServerEvent[] {
    return this.send.mock.calls.map(([message]) =>
      Schema.decodeUnknownSync(PresenceServerEventSchema)(JSON.parse(message)),
    )
  }
}

let database: SqliteD1Database
let sockets: Socket[]
let state: DurableObjectState
let object: PresenceObject
const asWebSocket = (socket: Socket) => socket as unknown as WebSocket
const rect = (x: number) => ({ x, y: 0, w: 8, h: 8 })
const request = (overrides: Record<string, string> = {}) =>
  new Request('https://example.com', {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-protocol': PRESENCE_PROTOCOL_V1,
      'x-caelestis-season': '0',
      'x-caelestis-surface-kind': 'world',
      'x-caelestis-painter-id': '1',
      'x-caelestis-painter-name': encodeURIComponent('Mia 🎨'),
      'x-caelestis-token-hash': 'a'.repeat(64),
      'x-caelestis-client-hash': 'b'.repeat(64),
      'x-caelestis-credential-scope': 'report',
      'x-caelestis-anonymous': '0',
      'x-caelestis-revocable': '0',
      ...overrides,
    },
  })
const update = (socket: Socket, fields: object) =>
  object.webSocketMessage(
    asWebSocket(socket),
    JSON.stringify({ type: 'presence-update', ...fields }),
  )
const tick = () => vi.advanceTimersByTime(PRESENCE_TICK_MS)
const attach = async (headers: Record<string, string> = {}) => {
  const response = await object.fetch(request(headers))
  expect(response.status).toBe(101)
  return sockets[sockets.length - 1] as Socket
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', { OPEN: 1 })
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    },
  )
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new Socket()
      1 = new Socket()
    },
  )
  const NativeResponse = Response
  vi.stubGlobal(
    'Response',
    class extends NativeResponse {
      private readonly upgrade: boolean
      constructor(body: BodyInit | null, init: ResponseInit) {
        super(body, { ...init, status: init.status === 101 ? 200 : (init.status ?? 200) })
        this.upgrade = init.status === 101
      }
      override get status() {
        return this.upgrade ? 101 : super.status
      }
    },
  )
  database = new SqliteD1Database()
  sockets = []
  state = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: Socket) => sockets.push(socket),
  } as unknown as DurableObjectState
  object = new PresenceObject(state, { DB: database } as unknown as Env)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  database.close()
})

describe('presence room', () => {
  it('sends nearby masks, excludes self, and removes peers when the viewport moves away', async () => {
    const a = await attach()
    const b = await attach()
    update(a, {
      viewport: rect(0),
      draft: { rect: { x: 1, y: 1, w: 1, h: 1 }, pixels: 1, mask: 'gA==' },
    })
    update(b, { viewport: rect(504) })
    tick()
    const delta = b.events().at(-1)
    expect(delta).toMatchObject({
      type: 'presence-delta',
      online: 2,
      upsert: [{ painter: { displayName: 'Mia 🎨' }, draft: { rect: rect(0), pixels: 1 } }],
    })
    if (delta?.type !== 'presence-delta') throw new Error('Expected delta')
    const draft = delta.upsert[0]?.draft
    expect(draft?.mask).toBeDefined()
    expect(draft && decodePresenceDraftMask(draft)?.[9]).toBe(1)
    const own = a.events()[0]
    if (own?.type !== 'presence-ready') throw new Error('Expected ready')
    expect(
      a
        .events()
        .filter((event) => event.type === 'presence-delta')
        .flatMap((event) => event.upsert)
        .some((peer) => peer.sessionId === own.sessionId),
    ).toBe(false)
    update(b, { viewport: rect(5_000) })
    tick()
    expect(b.events().at(-1)).toMatchObject({
      type: 'presence-delta',
      upsert: [],
      remove: [own.sessionId],
    })
    expect(JSON.stringify(a.deserializeAttachment()).length).toBeLessThan(2_048)
    expect(JSON.stringify(a.deserializeAttachment())).not.toContain('mask')
  })

  it('limits incoming traffic and closes oversized messages before decoding', async () => {
    const socket = await attach()
    for (let n = 0; n <= MAX_PRESENCE_MESSAGES_PER_SECOND; n++)
      object.webSocketMessage(asWebSocket(socket), '{}')
    expect(socket.close).toHaveBeenCalledWith(1008, 'presence rate limit')
    const oversized = await attach()
    object.webSocketMessage(asWebSocket(oversized), 'x'.repeat(MAX_PRESENCE_MESSAGE_CODE_UNITS + 1))
    expect(oversized.close).toHaveBeenCalledWith(1009, 'presence message too large')
  })

  it('ignores read updates and malformed payloads; observers receive online counts only', async () => {
    const read = await attach({ 'x-caelestis-credential-scope': 'read' })
    const publisher = await attach()
    update(read, { viewport: rect(0), draft: { rect: rect(0), pixels: 1 } })
    update(publisher, { viewport: rect(0) })
    object.webSocketMessage(asWebSocket(publisher), 'bad json')
    object.webSocketMessage(asWebSocket(publisher), new ArrayBuffer(5))
    tick()
    expect(read.deserializeAttachment()).toMatchObject({ viewport: null, draftRect: null })
    expect(read.events().at(-1)).toEqual({
      type: 'presence-delta',
      online: 2,
      upsert: [],
      remove: [],
    })
    expect(publisher.close).not.toHaveBeenCalled()
  })

  it('drops stale sessions on a heartbeat tick and delivers their removal', async () => {
    const stale = await attach()
    const active = await attach()
    update(stale, { viewport: rect(0) })
    update(active, { viewport: rect(0) })
    tick()
    vi.setSystemTime(Date.now() + PRESENCE_STALE_MS + 1)
    object.webSocketMessage(asWebSocket(active), JSON.stringify({ type: 'presence-heartbeat' }))
    tick()
    expect(stale.close).toHaveBeenCalledWith(1000, 'presence stale')
    expect(active.events().at(-1)).toMatchObject({
      online: 1,
      upsert: [],
      remove: [expect.any(String)],
    })
  })

  it('caps interest to the nearest peers and recovers in-memory delivery state after hibernation', async () => {
    const subscriber = await attach()
    update(subscriber, { viewport: rect(0) })
    for (let i = 1; i <= MAX_PRESENCE_PEERS + 2; i++) {
      const peer = await attach({
        'x-caelestis-client-hash': i.toString(16).padStart(64, '0'),
        'x-caelestis-painter-id': String(i),
      })
      update(peer, {
        viewport: rect(i * 8),
        draft: { rect: rect(i * 8), pixels: 1, mask: 'gAAAAAAAAAA=' },
      })
    }
    tick()
    const delta = subscriber.events().at(-1)
    expect(delta).toMatchObject({ upsert: expect.any(Array) })
    if (delta?.type !== 'presence-delta') throw new Error('Expected delta')
    expect(delta.upsert.map((peer) => peer.painter.wplaceUserId)).toEqual(
      Array.from({ length: MAX_PRESENCE_PEERS }, (_, i) => i + 1),
    )
    object = new PresenceObject(state, { DB: database } as unknown as Env)
    object.webSocketMessage(asWebSocket(subscriber), JSON.stringify({ type: 'presence-heartbeat' }))
    tick()
    expect(subscriber.events().at(-1)).toMatchObject({
      upsert: expect.arrayContaining([
        expect.objectContaining({ draft: { rect: rect(8), pixels: 1 } }),
      ]),
    })
  })

  it('checks capacity, malformed headers, protocol negotiation, and revoked credentials', async () => {
    const response = await object.fetch(request())
    expect(response.headers.get('sec-websocket-protocol')).toBe(PRESENCE_PROTOCOL_V1)
    for (let n = 1; n < MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT; n++) await attach()
    expect((await object.fetch(request())).status).toBe(503)
    const fake = sockets[0] as Socket
    sockets = Array.from({ length: MAX_PRESENCE_SUBSCRIBERS }, () => fake)
    const capacity = await object.fetch(request({ 'x-caelestis-client-hash': 'c'.repeat(64) }))
    expect(capacity.status).toBe(503)
    expect(capacity.headers.get('Retry-After')).toBe('30')
    sockets = []
    expect((await object.fetch(request({ 'x-caelestis-painter-name': '%' }))).status).toBe(400)
    expect((await object.fetch(request({ 'x-caelestis-season': '-1' }))).status).toBe(400)
    expect((await object.fetch(request({ 'x-caelestis-revocable': '1' }))).status).toBe(401)
    const sql = new D1SqlStore(database as unknown as D1Database)
    await sql.insertAccessToken({
      tokenHash: 'a'.repeat(64),
      label: 'report',
      scope: 'report',
      createdWithToken: 'c'.repeat(64),
      createdAt: millis(Date.now()),
    })
    const socket = await attach({ 'x-caelestis-revocable': '1' })
    await object.closeCredential('a'.repeat(64))
    expect(socket.close).toHaveBeenCalledWith(1008, 'credential revoked')
  })

  it('broadcasts persisted regions and removes closed peers', async () => {
    const sql = new D1SqlStore(database as unknown as D1Database)
    const shape: RegionShape = {
      kind: 'star',
      cx: 20,
      cy: 20,
      r: 10,
      inner: 4,
      points: 5,
      rotation: 90,
    }
    const region: RegionClaim = {
      id: uuidV7(),
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      templateId: uuidV7(),
      claimant: { wplaceUserId: 1, displayName: 'Mia' },
      document: { items: [{ id: 'star', shape, op: 'add' }] },
      rect: regionShapeBounds(shape),
      label: '',
      createdAt: Date.now(),
    }
    await sql.regions.createRegion(region)
    const a = await attach()
    const b = await attach()
    expect(b.events()[0]).toMatchObject({ type: 'presence-ready', regions: [region] })
    update(a, { viewport: rect(0) })
    update(b, { viewport: rect(0) })
    tick()
    const nextShape: RegionShape = { kind: 'ellipse', x: 0, y: 0, w: 8, h: 8 }
    const nextDocument: RegionDocument = {
      items: [{ id: 'ellipse', shape: nextShape, op: 'add' }],
    }
    const updated = await sql.regions.updateRegion(region.id, nextDocument, 'Updated')
    await object.publishRegions(0, WORLD_TEMPLATE_SURFACE)
    expect(b.events().at(-1)).toEqual({ type: 'regions', regions: [updated] })
    expect(updated).toEqual({ ...region, document: nextDocument, rect: rect(0), label: 'Updated' })
    object.webSocketError(asWebSocket(a))
    tick()
    expect(b.events().at(-1)).toMatchObject({ online: 1, remove: [expect.any(String)] })
  })
})
