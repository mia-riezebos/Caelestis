import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { Ports } from '../ports/index.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'
const EVENT_ID = '01890f3e-7b2c-7abc-8def-0123456789ac'

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const harness = async () => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const counters = new MemoryCounterStore(sql, () => millis(Date.now()))
  const ports: Ports = { blobs, sql, counters }
  await sql.insertNode({
    id: NODE_ID,
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
    app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP, currentSeason: 1 }),
  }
}

const mintToken = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  scope: 'read' | 'report',
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
  expect(response.status).toBe(204)
  return hash
}

describe('telemetry routes', () => {
  it('requests missing template-covered tiles and serves server-backed progress after upload', async () => {
    const { app } = await harness()
    const templateId = await createPublishedTemplate(app)
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
    await expect(offered.json()).resolves.toEqual({ wanted: ['0/0'] })

    const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
      method: 'PUT',
      headers: {
        ...bearer(reportToken),
        'content-type': 'image/png',
        'x-caelestis-season': '0',
        'x-caelestis-observed-at': String(now),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': encodeURIComponent('Mía 🎨'),
      },
      body: bytes,
    })
    expect(uploaded.status).toBe(204)

    const status = await app.request('/telemetry/status?season=0', {
      headers: bearer(reportToken),
    })
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({
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

    const repeated = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify(offer),
    })
    await expect(repeated.json()).resolves.toEqual({ wanted: [] })

    const duplicate = await app.request('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { ...bearer(reportToken), 'content-type': 'application/json' },
      body: JSON.stringify({ ...offer, offers: [offer.offers[0], offer.offers[0]] }),
    })
    expect(duplicate.status).toBe(400)
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
})
