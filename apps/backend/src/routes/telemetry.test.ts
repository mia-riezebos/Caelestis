import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { type AppOptions, createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import type { StatusReadModelPort } from '../status-read-model/port.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const TOKEN = 'a'.repeat(64)
const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'
const EVENT_ID = '01890f3e-7b2c-7abc-8def-0123456789ac'
const CLIENT_ID = '01890f3e-7b2c-7abc-8def-0123456789ad'
type LiveConnection = Parameters<NonNullable<AppOptions['connectStatusLive']>>[1]

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const harness = async (statusReadModel?: StatusReadModelPort, currentSeason = 0) => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const counters = new MemoryCounterStore(sql, () => millis(Date.now()))
  const context = makeBackendContext(blobs, sql, counters, statusReadModel)
  await sql.insertNode({
    id: NODE_ID,
    surface: WORLD_TEMPLATE_SURFACE,
    season: 0,
    parentId: null,
    path: '/templates',
    name: 'Templates',
    description: null,
    createdAt: millis(Date.now()),
  })
  return {
    blobs,
    sql,
    counters,
    app: createApp(context, { bootstrapAdminToken: BOOTSTRAP, currentSeason }),
  }
}

const mintToken = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  scope: 'read' | 'report' | 'admin',
): Promise<string> => {
  const response = await app.request('/admin/tokens', {
    method: 'POST',
    headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' },
    body: JSON.stringify({ label: scope, scope }),
  })
  return ((await response.json()) as { token: string }).token
}

const createPublishedTemplate = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
): Promise<string> => {
  const png = await encodeIndexedPng(3, 1, new Uint8Array([0, 1, 2]))
  const form = new FormData()
  form.set('png', new File([png.slice()], 'template.png', { type: 'image/png' }))
  form.set('nodeId', NODE_ID)
  form.set('name', 'Telemetry template')
  form.set('originX', '0')
  form.set('originY', '0')
  const created = await app.request('/admin/templates', {
    method: 'POST',
    headers: bearer(BOOTSTRAP),
    body: form,
  })
  const { templateId } = (await created.json()) as { templateId: string }
  await app.request(`/admin/templates/${templateId}`, {
    method: 'PATCH',
    headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' },
    body: JSON.stringify({ published: true }),
  })
  return templateId
}

const canvasTile = async (): Promise<Uint8Array> => {
  const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  indices[0] = 0
  indices[2] = 1
  return encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
}

const changedCanvasTile = async (index: number): Promise<Uint8Array> => {
  const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  indices[0] = index
  return encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
}

const setFinished = (
  app: Awaited<ReturnType<typeof harness>>['app'],
  templateId: string,
  finished: boolean,
) =>
  app.request(`/admin/templates/${templateId}`, {
    method: 'PATCH',
    headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' },
    body: JSON.stringify({ finished }),
  })

const uploadCanvas = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  token: string,
  bytes: Uint8Array,
  at: number,
): Promise<string> => {
  const hash = await sha256Hex(bytes)
  const response = await app.request(`/telemetry/tiles/0/0/${hash}`, {
    method: 'PUT',
    headers: {
      ...bearer(token),
      'x-caelestis-season': '0',
      'x-caelestis-observed-at': String(at),
      'x-caelestis-wplace-user-id': '42',
      'x-caelestis-display-name': 'Mia',
    },
    body: bytes,
  })
  expect(response.status).toBe(200)
  return hash
}

describe('telemetry routes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads historical status directly without creating a season read model', async () => {
    const reconcileSnapshot = vi.fn(async () => {
      throw new Error('historical status must not reach the read model')
    })
    const { app } = await harness(
      { applyCommittedChange: vi.fn(async () => null), reconcileSnapshot },
      1,
    )
    const readToken = await mintToken(app, 'read')

    const response = await app.request('/telemetry/status?season=0', {
      headers: bearer(readToken),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ templates: [] })
    expect(reconcileSnapshot).not.toHaveBeenCalled()
  })

  it('rejects historical tile offers and uploads before resolving a season read model', async () => {
    const resolveCurrentTileOffers = vi.fn()
    const prepareTileGenerationCommit = vi.fn()
    const { app } = await harness({
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
      resolveCurrentTileOffers,
      prepareTileGenerationCommit,
    })
    const reportToken = await mintToken(app, 'report')
    const now = Math.floor(Date.now() / 1_000)

    const offered = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        wplaceUserId: 42,
        displayName: 'Mia',
        season: 1,
        offers: [{ tile: '0/0', sha256: 'a'.repeat(64), ts: now }],
      }),
    })
    const uploaded = await app.request(`/telemetry/tiles/0/0/${'a'.repeat(64)}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '1',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: new Uint8Array([1]),
    })

    expect(offered.status).toBe(400)
    expect(uploaded.status).toBe(400)
    expect(resolveCurrentTileOffers).not.toHaveBeenCalled()
    expect(prepareTileGenerationCommit).not.toHaveBeenCalled()
  })

  it('authenticates and scope-binds live upgrades before resolving a season object', async () => {
    const blobs = new MemoryBlobStore()
    const sql = new MemorySqlStore()
    const counters = new MemoryCounterStore(sql, () => millis(Date.now()))
    const connectStatusLive = vi.fn(
      async (_request: Request, _connection: LiveConnection) => new Response(null, { status: 204 }),
    )
    const app = createApp(makeBackendContext(blobs, sql, counters), {
      bootstrapAdminToken: BOOTSTRAP,
      currentSeason: 7,
      connectStatusLive,
    })
    const readToken = await mintToken(app, 'read')
    const upgrade = (token: string) => ({
      upgrade: 'websocket',
      'sec-websocket-protocol': `caelestis.live.v1, caelestis.auth.b64.${btoa(token).replace(/=+$/, '')}`,
    })

    await expect((await app.request('/server')).json()).resolves.toMatchObject({
      liveSync: 1,
      liveTileOffers: 1,
    })
    await expect(
      (await app.request('/manifest', { headers: bearer(readToken) })).json(),
    ).resolves.toMatchObject({
      server: { liveSync: 1, liveTileOffers: 1 },
    })
    expect(
      (
        await app.request('/telemetry/live?season=99&scope=public', {
          headers: upgrade(readToken),
        })
      ).status,
    ).toBe(404)
    expect(connectStatusLive).not.toHaveBeenCalled()

    expect(
      (
        await app.request('/telemetry/live?season=7&scope=admin', {
          headers: upgrade(readToken),
        })
      ).status,
    ).toBe(403)
    expect(connectStatusLive).not.toHaveBeenCalled()

    const publicResponse = await app.request(
      '/telemetry/live?season=7&scope=public&revision=4&client=userscript&clientVersion=0.5.4',
      { headers: upgrade(readToken) },
    )
    expect(publicResponse.status).toBe(204)
    expect(connectStatusLive).toHaveBeenLastCalledWith(expect.any(Request), {
      season: 7,
      scope: 'public',
      credentialScope: 'read',
      tokenHash: await hashToken(readToken),
      clientHash: await hashToken(readToken),
      anonymous: false,
      revocable: true,
      lastRevision: 4,
      metricClient: 'userscript',
      metricClientVersion: '0.5.4',
    })

    const adminResponse = await app.request('/telemetry/live?season=7&scope=admin', {
      headers: upgrade(BOOTSTRAP),
    })
    expect(adminResponse.status).toBe(204)
    expect(connectStatusLive).toHaveBeenLastCalledWith(expect.any(Request), {
      season: 7,
      scope: 'admin',
      credentialScope: 'admin',
      tokenHash: await hashToken(BOOTSTRAP),
      clientHash: await hashToken(BOOTSTRAP),
      anonymous: false,
      revocable: false,
      lastRevision: null,
      metricClient: 'unknown',
      metricClientVersion: 'unknown',
    })

    const downgradedResponse = await app.request('/telemetry/live?season=7&scope=public', {
      headers: upgrade(BOOTSTRAP),
    })
    expect(downgradedResponse.status).toBe(204)
    expect(connectStatusLive).toHaveBeenLastCalledWith(expect.any(Request), {
      season: 7,
      scope: 'public',
      credentialScope: 'admin',
      tokenHash: await hashToken(BOOTSTRAP),
      clientHash: await hashToken(BOOTSTRAP),
      anonymous: false,
      revocable: false,
      lastRevision: null,
      metricClient: 'unknown',
      metricClientVersion: 'unknown',
    })
  })

  it('uses a browser client id instead of the network address for anonymous live capacity', async () => {
    const blobs = new MemoryBlobStore()
    const sql = new MemorySqlStore()
    const counters = new MemoryCounterStore(sql, () => millis(Date.now()))
    const connectStatusLive = vi.fn(
      async (_request: Request, _connection: LiveConnection) => new Response(null, { status: 204 }),
    )
    const app = createApp(makeBackendContext(blobs, sql, counters), {
      currentSeason: 7,
      openAccess: true,
      connectStatusLive,
    })
    const headers = (ip: string) => ({
      upgrade: 'websocket',
      'sec-websocket-protocol': 'caelestis.live.v1',
      'cf-connecting-ip': ip,
    })
    const otherClientId = '01890f3e-7b2c-7abc-8def-0123456789ae'

    await app.request(`/telemetry/live?season=7&scope=public&clientId=${CLIENT_ID}`, {
      headers: headers('203.0.113.1'),
    })
    await app.request(`/telemetry/live?season=7&scope=public&clientId=${CLIENT_ID}`, {
      headers: headers('203.0.113.2'),
    })
    await app.request(`/telemetry/live?season=7&scope=public&clientId=${otherClientId}`, {
      headers: headers('203.0.113.1'),
    })

    const connections = connectStatusLive.mock.calls.map(([, connection]) => connection)
    expect(connections[0]?.clientHash).toBe(connections[1]?.clientHash)
    expect(connections[2]?.clientHash).not.toBe(connections[0]?.clientHash)
    expect(connections.every((connection) => connection.anonymous)).toBe(true)
  })

  it('serves active alarms with read scope and hides unpublished templates from readers', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const now = millis(Date.now())
    const versionId = (await sql.readTemplate(templateId))?.currentVersionId
    expect(versionId).toBeDefined()
    const snapshot = (correct: number) => ({
      templateId,
      versionId: versionId ?? '',
      total: 100_000,
      correct,
      observedAt: now,
    })
    await sql.evaluateTemplateAlarm(snapshot(60_000), { kind: 'scan' }, EVENT_ID)
    await sql.evaluateTemplateAlarm(snapshot(59_900), { kind: 'scan' }, EVENT_ID)

    const active = await app.request('/telemetry/alarms?season=0', {
      headers: bearer(readToken),
    })
    expect(active.status).toBe(200)
    await expect(active.json()).resolves.toEqual({
      alarms: [
        expect.objectContaining({
          id: EVENT_ID,
          templateId,
          kind: 'regression',
          pixelsLost: 100,
        }),
      ],
    })

    await sql.setTemplatePublishedAt(templateId, null, millis(now + 1))
    const hidden = await app.request('/telemetry/alarms?season=0', {
      headers: bearer(readToken),
    })
    await expect(hidden.json()).resolves.toEqual({ alarms: [] })
    const admin = await app.request('/telemetry/alarms?season=0', {
      headers: bearer(BOOTSTRAP),
    })
    await expect(admin.json()).resolves.toEqual({
      alarms: [expect.objectContaining({ id: EVENT_ID })],
    })
  })

  it('validates alarm season and requires read scope', async () => {
    const { app } = await harness()
    expect((await app.request('/telemetry/alarms?season=-1')).status).toBe(401)
    const readToken = await mintToken(app, 'read')
    expect(
      (await app.request('/telemetry/alarms?season=-1', { headers: bearer(readToken) })).status,
    ).toBe(400)
  })

  it('requests missing template-covered tiles and serves server-backed progress after upload', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readTemplateStatuses = vi.spyOn(sql, 'readTemplateStatuses')
    readTemplateStatuses.mockClear()
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = seconds(Math.floor(Date.now() / 1_000))
    const offer = {
      wplaceUserId: 42,
      displayName: 'Mia',
      season: 0,
      offers: [{ tile: '0/0', sha256: hash, ts: now }],
    }

    const offered = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify(offer),
    })
    expect(offered.status).toBe(200)
    const offeredBody = (await offered.json()) as { coverageToken: string }
    expect(offeredBody).toEqual({
      wanted: ['0/0'],
      acknowledged: [],
      rejected: [],
      coverageToken: expect.any(String),
    })

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'content-type': 'image/png',
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': encodeURIComponent('Mía 🎨'),
        'x-caelestis-tile-coverage-token': offeredBody.coverageToken,
      },
      body: bytes,
    })
    expect(uploaded.status).toBe(200)
    await expect(uploaded.json()).resolves.toEqual({
      status: {
        baseRevision: 1,
        revision: 2,
        templates: [
          {
            templateId,
            correct: 1,
            wrong: 1,
            blank: 1,
            total: 3,
            colours: [
              { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
              { index: 1, correct: 0, wrong: 0, blank: 1, total: 1 },
              { index: 2, correct: 0, wrong: 1, blank: 0, total: 1 },
            ],
            observedAt: now * 1_000,
          },
        ],
        removedTemplateIds: [],
      },
    })
    expect(readTemplateStatuses).not.toHaveBeenCalled()

    const status = await app.request('/telemetry/status?season=0', {
      headers: bearer(reportToken),
    })
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({
      revision: 2,
      templates: [
        {
          templateId,
          correct: 1,
          wrong: 1,
          blank: 1,
          total: 3,
          colours: [
            { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
            { index: 1, correct: 0, wrong: 0, blank: 1, total: 1 },
            { index: 2, correct: 0, wrong: 1, blank: 0, total: 1 },
          ],
          observedAt: now * 1_000,
        },
      ],
    })

    const listTelemetryTargets = vi.spyOn(sql, 'listTelemetryTargets')
    const reserveTileBlob = vi.spyOn(sql, 'reserveTileBlob')
    listTelemetryTargets.mockClear()
    reserveTileBlob.mockClear()
    const repeated = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify(offer),
    })
    await expect(repeated.json()).resolves.toEqual({
      wanted: [],
      acknowledged: ['0/0'],
      rejected: [],
      coverageToken: expect.any(String),
    })
    expect(listTelemetryTargets).not.toHaveBeenCalled()
    expect(reserveTileBlob).not.toHaveBeenCalled()

    const rejected = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        ...offer,
        offers: [{ ...offer.offers[0], tile: '9/9' }],
      }),
    })
    await expect(rejected.json()).resolves.toEqual({
      wanted: [],
      acknowledged: [],
      rejected: ['9/9'],
      coverageToken: expect.any(String),
    })

    const duplicate = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({ ...offer, offers: [offer.offers[0], offer.offers[0]] }),
    })
    expect(duplicate.status).toBe(400)
  })

  it('rejects an oversized tile-offer body before JSON decoding', async () => {
    const { app } = await harness()
    const reportToken = await mintToken(app, 'report')

    const response = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid tile offer batch' })
  })

  it('omits an oversized response-applied delta without losing the tile disposition', async () => {
    const templates = Array.from({ length: 100 }, (_, templateIndex) => ({
      templateId: `template-${templateIndex}`,
      correct: 1,
      wrong: 1,
      blank: 1,
      total: 3,
      observedAt: millis(1_800_000_000_000),
      colours: Array.from({ length: 32 }, (_, index) => ({
        index,
        correct: 1,
        wrong: 0,
        blank: 0,
        total: 1,
      })),
    }))
    const delta = { baseRevision: 0, revision: 1, templates, removedTemplateIds: [] }
    const { app } = await harness({
      applyCommittedChange: vi.fn(async () => ({ public: delta, admin: delta })),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
    })
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = seconds(Math.floor(Date.now() / 1_000))

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })
    await expect(uploaded.json()).resolves.toEqual({})

    const offered = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        wplaceUserId: 42,
        displayName: 'Mia',
        season: 0,
        offers: [{ tile: '0/0', sha256: hash, ts: now + 1 }],
      }),
    })
    await expect(offered.json()).resolves.toEqual({
      wanted: [],
      acknowledged: ['0/0'],
      rejected: [],
    })
  })

  it('repairs an upload with the server prepare token when the client coverage token is stale', async () => {
    const serverCommit = {
      coverageToken: '01890f3e-7b2c-7abc-8def-012345678900',
      commitToken: '01890f3e-7b2c-7abc-8def-012345678901',
      commitExpiresAt: Date.now() + 5 * 60_000,
    }
    const applyCommittedTileGeneration = vi.fn(async () => undefined)
    const { app } = await harness({
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
      prepareTileGenerationCommit: vi.fn(async () => serverCommit),
      applyCommittedTileGeneration,
    })
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = Math.floor(Date.now() / 1_000)

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
        'x-caelestis-tile-coverage-token': '01890f3e-7b2c-7abc-8def-012345678902',
      },
      body: bytes,
    })

    expect(uploaded.status).toBe(200)
    expect(applyCommittedTileGeneration).toHaveBeenCalledWith(
      0,
      expect.objectContaining(serverCommit),
    )
  })

  it('releases a prepared tile generation when upload accounting fails before commit', async () => {
    const serverCommit = {
      coverageToken: '01890f3e-7b2c-7abc-8def-012345678900',
      commitToken: '01890f3e-7b2c-7abc-8def-012345678901',
      commitExpiresAt: Date.now() + 5 * 60_000,
    }
    const finishTileGenerationCommit = vi.fn(async () => undefined)
    const { app, sql } = await harness({
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
      prepareTileGenerationCommit: vi.fn(async () => serverCommit),
      finishTileGenerationCommit,
    })
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const accountingError = new Error('painter accounting unavailable')
    vi.spyOn(sql, 'rememberPainter').mockRejectedValue(accountingError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(Math.floor(Date.now() / 1_000)),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })

    expect(response.status).toBe(500)
    expect(finishTileGenerationCommit).toHaveBeenCalledWith(0, { x: 0, y: 0 }, serverCommit)
    expect(consoleError).toHaveBeenCalledWith(accountingError)
  })

  it('keeps upload validation separate from typed storage failures', async () => {
    const { app, blobs } = await harness()
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = Math.floor(Date.now() / 1_000)
    const upload = (claimedHash: string) =>
      app.request(`/telemetry/tiles/0/0/${claimedHash}`, {
        method: 'PUT',
        headers: {
          ...bearer(reportToken),
          'x-caelestis-season': '0',
          'x-caelestis-observed-at': String(now),
          'x-caelestis-wplace-user-id': '42',
          'x-caelestis-display-name': 'Mia',
        },
        body: bytes,
      })

    const invalid = await upload('f'.repeat(64))
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({
      error: 'tile bytes do not match their sha256',
    })

    const error = new Error('blob storage unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    blobs.put = async () => {
      throw error
    }
    const unavailable = await upload(hash)
    expect(unavailable.status).toBe(500)
    expect(await unavailable.text()).toBe('Internal Server Error')
    expect(consoleError).toHaveBeenCalledWith(error)
  })

  it('keeps an accepted tile authoritative when projection repair fails', async () => {
    const projectionError = new Error('read model unavailable')
    const applyCommittedChange = vi.fn(async () => Promise.reject(projectionError))
    const { app, sql } = await harness({
      applyCommittedChange,
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
    })
    await createPublishedTemplate(app)
    applyCommittedChange.mockClear()
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = seconds(Math.floor(Date.now() / 1_000))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })

    expect(uploaded.status).toBe(200)
    await expect(sql.readTemplateStatuses(0, false)).resolves.toHaveLength(1)
    expect(applyCommittedChange).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ baseRevision: 0, revision: 1 }),
    )
    expect(consoleError).toHaveBeenCalledWith(projectionError)
  })

  it('falls through to authoritative offer processing when the cache read fails', async () => {
    const cacheError = new Error('cache shard unavailable')
    const resolveCurrentTileOffers = vi.fn(async () => Promise.reject(cacheError))
    const { app } = await harness({
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
      resolveCurrentTileOffers,
    })
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const offered = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        wplaceUserId: 42,
        displayName: 'Mia',
        season: 0,
        offers: [
          {
            deliveryId: EVENT_ID,
            tile: '0/0',
            sha256: 'b'.repeat(64),
            ts: seconds(Math.floor(Date.now() / 1_000)),
          },
        ],
      }),
    })

    expect(offered.status).toBe(200)
    await expect(offered.json()).resolves.toEqual({
      wanted: ['0/0'],
      acknowledged: [],
      rejected: [],
    })
    expect(resolveCurrentTileOffers).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith('tile generation cache read failed', cacheError)
  })

  it('publishes an accepted revision before non-fatal derived artifact writes', async () => {
    const order: string[] = []
    const applyCommittedChange = vi.fn(async () => {
      order.push('projection')
      return null
    })
    const { app, blobs, sql } = await harness({
      applyCommittedChange,
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
    })
    await createPublishedTemplate(app)
    applyCommittedChange.mockClear()
    const originalPut = blobs.put.bind(blobs)
    const artifactError = new Error('derived R2 unavailable')
    blobs.put = async (namespace, key, bytes) => {
      if (namespace === 'derived') {
        order.push('artifact')
        throw artifactError
      }
      return originalPut(namespace, key, bytes)
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(Math.floor(Date.now() / 1_000)),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })

    expect(uploaded.status).toBe(200)
    expect(order.at(-1)).toBe('artifact')
    expect(order.slice(0, -1)).not.toHaveLength(0)
    expect(order.slice(0, -1).every((step) => step === 'projection')).toBe(true)
    await expect(sql.readTemplateStatuses(0, false)).resolves.toHaveLength(1)
    expect(consoleError).toHaveBeenCalledWith(
      'failed to persist derived mismatch artifact',
      artifactError,
    )
  })

  it('repairs accepted uploads and known offers before a later history fold can fail', async () => {
    const applyCommittedChange = vi.fn(async () => null)
    const { app, sql } = await harness({
      applyCommittedChange,
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 0, templates: [] },
      })),
    })
    await createPublishedTemplate(app)
    applyCommittedChange.mockClear()
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = seconds(Math.floor(Date.now() / 1_000))
    const foldError = new Error('history fold unavailable')
    sql.foldTileHistory = vi.fn(async () => Promise.reject(foldError))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })
    expect(uploaded.status).toBe(500)
    await expect(sql.readTemplateStatuses(0, false)).resolves.toHaveLength(1)
    expect(applyCommittedChange).toHaveBeenCalledTimes(1)

    const offered = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        wplaceUserId: 42,
        displayName: 'Mia',
        season: 0,
        offers: [{ tile: '0/0', sha256: hash, ts: now + 1 }],
      }),
    })
    expect(offered.status).toBe(500)
    expect(applyCommittedChange).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledWith(foldError)
  })

  it('clamps future tile observations to server receipt time', async () => {
    const { app, sql } = await harness()
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const receivedAfter = Math.floor(Date.now() / 1_000)

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(receivedAfter + 86_400),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })

    expect(uploaded.status).toBe(200)
    await expect(sql.readLatestTile(0, { x: 0, y: 0 })).resolves.toEqual(
      expect.objectContaining({ observedAt: expect.any(Number) }),
    )
    expect((await sql.readLatestTile(0, { x: 0, y: 0 }))?.observedAt).toBeLessThanOrEqual(
      Date.now() + 5 * 60 * 1_000,
    )
  })

  it('classifies accepted paints once and rejects read-only reporting', async () => {
    const { app, counters } = await harness()
    const templateId = await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const readToken = await mintToken(app, 'read')
    const bytes = await canvasTile()
    const hash = await sha256Hex(bytes)
    const now = seconds(Math.floor(Date.now() / 1_000))
    await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Mia',
      },
      body: bytes,
    })
    const event = {
      eventId: EVENT_ID,
      wplaceUserId: 42,
      displayName: 'Mia',
      season: 0,
      ts: now,
      tiles: [{ x: 0, y: 0, pixels: { x: [2], y: [0], colors: [3] } }],
      painted: 1,
    }
    const report = () =>
      app.request('/telemetry/paints', {
        method: 'POST',
        headers: { ...bearer(reportToken), 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })

    expect((await report()).status).toBe(200)
    const duplicate = await report()
    await expect(duplicate.json()).resolves.toMatchObject({
      accepted: false,
      duplicate: true,
    })
    await expect(counters.readPending([templateId])).resolves.toEqual([
      expect.objectContaining({ templateId, placed: 1, correct: 1, repairs: 1 }),
    ])

    const forbidden = await app.request('/telemetry/paints', {
      method: 'POST',
      headers: { ...bearer(readToken), 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, eventId: '01890f3e-7b2c-7abc-8def-0123456789ad' }),
    })
    expect(forbidden.status).toBe(403)
  })

  it('stops history for a finished template, keeps grief status live, and resumes after reopen', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const now = Math.floor(Date.now() / 1_000)
    const firstHash = await uploadCanvas(app, reportToken, await canvasTile(), now)

    expect((await setFinished(app, templateId, true)).status).toBe(200)
    const griefHash = await uploadCanvas(app, reportToken, await changedCanvasTile(3), now + 60)

    await expect(
      sql.readTileHistory({
        season: 0,
        tile: { x: 0, y: 0 },
        resolution: 0,
        fromSeconds: seconds(now - 1),
        toSeconds: seconds(now + 180),
      }),
    ).resolves.toEqual([{ bucketStart: now, hash: firstHash, reporters: 1 }])
    await expect(sql.readLatestTile(0, { x: 0, y: 0 })).resolves.toMatchObject({
      hash: griefHash,
      observedAt: (now + 60) * 1_000,
    })
    await expect(sql.readTemplateStatuses(0, true)).resolves.toEqual([
      expect.objectContaining({ templateId, wrong: 1, observedAt: (now + 60) * 1_000 }),
    ])

    expect((await setFinished(app, templateId, false)).status).toBe(200)
    const resumedHash = await uploadCanvas(app, reportToken, await changedCanvasTile(2), now + 120)
    await expect(
      sql.readTileHistory({
        season: 0,
        tile: { x: 0, y: 0 },
        resolution: 0,
        fromSeconds: seconds(now - 1),
        toSeconds: seconds(now + 180),
      }),
    ).resolves.toEqual([
      { bucketStart: now, hash: firstHash, reporters: 1 },
      { bucketStart: now + 120, hash: resumedHash, reporters: 1 },
    ])
  })

  it('keeps shared-tile history while any covering template remains live', async () => {
    const { app, sql } = await harness()
    const finishedId = await createPublishedTemplate(app)
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const now = Math.floor(Date.now() / 1_000)

    expect((await setFinished(app, finishedId, true)).status).toBe(200)
    const hash = await uploadCanvas(app, reportToken, await canvasTile(), now)

    await expect(
      sql.readTileHistory({
        season: 0,
        tile: { x: 0, y: 0 },
        resolution: 0,
        fromSeconds: seconds(now - 1),
        toSeconds: seconds(now + 1),
      }),
    ).resolves.toEqual([{ bucketStart: now, hash, reporters: 1 }])
  })

  it('does not credit paints against finished templates', async () => {
    const { app, sql, counters } = await harness()
    const templateId = await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const now = seconds(Math.floor(Date.now() / 1_000))
    await uploadCanvas(app, reportToken, await canvasTile(), now)
    expect((await setFinished(app, templateId, true)).status).toBe(200)

    const response = await app.request('/telemetry/paints', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: '01890f3e-7b2c-7abc-8def-0123456789ae',
        wplaceUserId: 42,
        displayName: 'Mia',
        season: 0,
        ts: now,
        tiles: [{ x: 0, y: 0, pixels: { x: [2], y: [0], colors: [3] } }],
        painted: 1,
      }),
    })

    expect(response.status).toBe(200)
    await expect(counters.readPending([templateId])).resolves.toEqual([
      expect.objectContaining({ templateId, placed: 0, correct: 0, repairs: 0 }),
    ])
    await expect(
      sql.readContributions({
        templateIds: [templateId],
        fromSeconds: seconds(now - 86_400),
        toSeconds: seconds(now + 86_400),
        includeUnpublished: true,
      }),
    ).resolves.toEqual([])
  })

  it('folds the touched tile after a save without racing blob writes', async () => {
    const { app, sql, blobs } = await harness()
    await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const now = Math.floor(Date.now() / 1_000)
    const oldHour = Math.floor((now - 2 * 86_400) / 3_600) * 3_600
    const discarded = '6'.repeat(64)
    const survivor = '7'.repeat(64)
    await blobs.put('tiles', discarded, new Uint8Array([1]))
    await blobs.put('tiles', survivor, new Uint8Array([2]))
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 0, y: 0 },
        hash: discarded,
        observedAt: millis((oldHour + 60) * 1_000),
        reportedAt: seconds(oldHour + 60),
        reportedWithToken: TOKEN,
        reportedByUserId: 1,
      },
      [],
    )
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 0, y: 0 },
        hash: survivor,
        observedAt: millis((oldHour + 120) * 1_000),
        reportedAt: seconds(oldHour + 120),
        reportedWithToken: TOKEN,
        reportedByUserId: 1,
      },
      [],
    )

    await uploadCanvas(app, reportToken, await canvasTile(), now)

    await expect(
      sql.readTileHistory({
        season: 0,
        tile: { x: 0, y: 0 },
        resolution: 3_600,
        fromSeconds: seconds(oldHour),
        toSeconds: seconds(oldHour + 3_600),
      }),
    ).resolves.toEqual([{ bucketStart: seconds(oldHour), hash: survivor, reporters: 1 }])
    // R2 has no conditional delete, so physical GC cannot safely race content-addressed writes.
    await expect(blobs.hasAll('tiles', [discarded, survivor])).resolves.toEqual(
      new Set([discarded, survivor]),
    )
  })
})
