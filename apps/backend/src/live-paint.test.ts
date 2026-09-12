import {
  encodeIndexedPng,
  encodeLivePaintParts,
  type LivePaintPart,
  millis,
  type PaintEvent,
  seconds,
  sha256Hex,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import { StatusReadModelObject } from './status-read-model-object.js'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
vi.stubGlobal('WebSocketRequestResponsePair', class {})
let database: SqliteD1Database | undefined
afterEach(() => database?.close())

const fixture = async () => {
  database = new SqliteD1Database()
  const sql = new D1SqlStore(database as unknown as D1Database)
  const chunk = await encodeIndexedPng(500, 100, new Uint8Array(50000).fill(30))
  const hash = await sha256Hex(chunk)
  const now = Date.now()
  for (const tileX of [0, 1]) {
    const templateId = uuidV7()
    await sql.insertTemplateVersion({
      templateId,
      versionId: uuidV7(),
      surface: WORLD_TEMPLATE_SURFACE,
      season: 0,
      nodeId: null,
      name: `Paint diagnostic ${tileX}`,
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(now),
      bbox: { minX: tileX * 1000 + 100, minY: 100, maxX: tileX * 1000 + 600, maxY: 200 },
      totalPixels: 50000,
      chunks: [{ tileX, tileY: 0, hash }],
    })
    await sql.setTemplatePublishedAt(templateId, millis(now), millis(now))
  }
  const state = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: () => [],
  } as unknown as DurableObjectState
  const env = {
    DB: database,
    BLOBS: {
      get: async (key: string) =>
        key === `chunks/${hash}` ? { arrayBuffer: async () => chunk.slice().buffer } : null,
    },
    TELEMETRY: { getByName: () => ({ record: async () => undefined }) },
  } as unknown as Env
  const object = new StatusReadModelObject(state, env)
  const socket = (credentialScope = 'report') => ({
    deserializeAttachment: () => ({
      season: 0,
      scope: 'public',
      credentialScope,
      tokenHash: 'a'.repeat(64),
      protocol: 2,
    }),
    send: vi.fn(),
    close: vi.fn(),
  })
  const event = (count: number): PaintEvent => ({
    eventId: uuidV7(),
    wplaceUserId: 2714778,
    displayName: '4dragonwings',
    season: 0,
    ts: seconds(Math.floor(now / 1000)),
    painted: count,
    tiles: Array.from({ length: Math.ceil(count / 50000) }, (_, x) => {
      const length = Math.min(50000, count - x * 50000)
      return {
        x,
        y: 0,
        pixels: {
          x: Array.from({ length }, (_, i) => 100 + (i % 500)),
          y: Array.from({ length }, (_, i) => 100 + Math.floor(i / 500)),
          colors: Array.from({ length }, () => 31),
        },
      }
    }),
  })
  const send = async (peer: ReturnType<typeof socket>, part: LivePaintPart, target = object) => {
    const requestId = uuidV7()
    await target.webSocketMessage(
      peer as unknown as WebSocket,
      JSON.stringify({ type: 'paint-part', requestId, ...part }),
    )
    return JSON.parse(String(peer.send.mock.calls.at(-1)?.[0] ?? '{}')) as {
      type?: string
      result?: string
      error?: string
    }
  }
  const contributions = () => sql.readContributions({ season: 0, includeUnpublished: false })
  return { object, state, env, socket, event, send, contributions }
}

it.each([6000, 100000])(
  'credits a %i-pixel report followed by 601 pixels, exactly once',
  async (count) => {
    const f = await fixture()
    const peer = f.socket()
    const event = f.event(count)
    const parts = encodeLivePaintParts(event, uuidV7())
    for (const part of parts) {
      const response = await f.send(peer, part)
      if (part.index < part.total - 1) expect(response.type).toBe('paint-part-result')
      else expect(response).toMatchObject({ type: 'paint-result', result: 'recorded' })
    }
    const first = await f.contributions()
    expect(first.reduce((sum, row) => sum + row.placed, 0)).toBe(count)
    if (count === 100000) expect(first.map((row) => row.placed)).toEqual([50000, 50000])
    // A lost final acknowledgement restarts transfer, preserving the event's accounting identity.
    for (const part of encodeLivePaintParts(event, uuidV7())) await f.send(peer, part)
    expect(await f.contributions()).toEqual(first)
    await f.object.webSocketMessage(
      peer as unknown as WebSocket,
      JSON.stringify({ type: 'paint-report', requestId: uuidV7(), event: f.event(601) }),
    )
    expect((await f.contributions()).reduce((sum, row) => sum + row.placed, 0)).toBe(count + 601)
    expect(peer.close).not.toHaveBeenCalled()
  },
)

it('restarts after disconnect or object eviction without applying incomplete parts', async () => {
  const f = await fixture()
  const event = f.event(6000)
  const parts = encodeLivePaintParts(event, uuidV7())
  const first = parts[0]
  const second = parts[1]
  if (first === undefined || second === undefined)
    throw new Error('fixture requires multiple parts')
  const old = f.socket()
  await f.send(old, first)
  expect(await f.contributions()).toEqual([])
  const evicted = new StatusReadModelObject(f.state, f.env)
  expect(await f.send(old, second, evicted)).toMatchObject({ error: 'unavailable' })
  f.object.webSocketClose(old as unknown as WebSocket, 1000, 'reconnect', true)
  const next = f.socket()
  for (const part of encodeLivePaintParts(event, uuidV7())) await f.send(next, part, evicted)
  expect((await f.contributions())[0]?.placed).toBe(6000)
})

it('rejects unauthorized, conflicting, and cross-season parts without accounting', async () => {
  const f = await fixture()
  const first = encodeLivePaintParts(f.event(6000), uuidV7())[0]
  if (first === undefined) throw new Error('fixture requires parts')
  expect(await f.send(f.socket('read'), first)).toMatchObject({ error: 'forbidden' })
  expect(await f.send(f.socket(), { ...first, season: 1 })).toMatchObject({ error: 'forbidden' })
  const peer = f.socket()
  await f.send(peer, first)
  expect(await f.send(peer, first)).toMatchObject({ type: 'paint-part-result' })
  expect(await f.send(peer, { ...first, chunk: '[' })).toMatchObject({ error: 'invalid' })
  expect(await f.contributions()).toEqual([])
})

it('validates complete JSON and event identity before accounting', async () => {
  const f = await fixture()
  const event = f.event(20)
  const first = encodeLivePaintParts(event, uuidV7())[0]
  if (first === undefined) throw new Error('fixture requires parts')
  const peer = f.socket()
  expect(await f.send(peer, { ...first, chunk: '{}' })).toMatchObject({ error: 'invalid' })
  expect(await f.send(peer, { ...first, eventId: uuidV7() })).toMatchObject({ error: 'invalid' })
  expect(await f.contributions()).toEqual([])
})
