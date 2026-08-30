import {
  BLANK,
  decodeMismatchMask,
  encodeIndexedPng,
  MATCH,
  millis,
  mismatchClassAt,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WRONG,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { ContributionDelta } from '../ports/index.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import { decodedPixelCache } from '../telemetry/decoded-pixel-cache.js'
import { mismatchArtifactKey } from '../telemetry/derived-classification.js'
import { selectTelemetryHistoryResolution, selectTileHistoryResolution } from './telemetry.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const NODE_ID = '01890f3e-7b2c-7abc-8def-0123456789ab'
const TOKEN_DIGEST = 'a'.repeat(64)
const DAY = seconds(1_750_032_000) // a UTC midnight
const NEXT_DAY = seconds(1_750_032_000 + 86_400)

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const harness = async () => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const counters = new MemoryCounterStore(sql, () => millis(Date.now()))
  const context = makeBackendContext(blobs, sql, counters)
  await sql.insertNode({
    id: NODE_ID,
    surface: { kind: 'world', allianceId: null },
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
    app: createApp(context, { bootstrapAdminToken: BOOTSTRAP, currentSeason: 1 }),
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

const createTemplate = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  publish: boolean,
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
  if (publish) {
    await app.request(`/admin/templates/${templateId}`, {
      method: 'PATCH',
      headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
  }
  return templateId
}

const createPublishedTemplate = (
  app: Awaited<ReturnType<typeof harness>>['app'],
): Promise<string> => createTemplate(app, true)

const canvasTile = async (): Promise<Uint8Array> => {
  const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  indices[0] = 0
  indices[2] = 1
  return encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
}

const uploadCanvasTile = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  reportToken: string,
  observedAt: number,
): Promise<string> => {
  const bytes = await canvasTile()
  const hash = await sha256Hex(bytes)
  const uploaded = await app.request(`/telemetry/tiles/0/0/${hash}`, {
    method: 'PUT',
    headers: {
      ...bearer(reportToken),
      'content-type': 'image/png',
      'x-caelestis-season': '0',
      'x-caelestis-observed-at': String(observedAt),
      'x-caelestis-wplace-user-id': '42',
      'x-caelestis-display-name': 'Mia',
    },
    body: bytes,
  })
  expect(uploaded.status).toBe(200)
  return hash
}

const contribution = (overrides: Partial<ContributionDelta>): ContributionDelta => ({
  templateId: 'set-me',
  wplaceUserId: 7,
  day: DAY,
  reportedWithToken: TOKEN_DIGEST,
  reportedByUserId: 1,
  placed: 10,
  correct: 8,
  repairs: 2,
  ...overrides,
})

describe('telemetry read routes', () => {
  afterEach(() => {
    decodedPixelCache.clear()
    vi.restoreAllMocks()
  })

  it('selects the coarsest retained tier that still yields about 200 points', () => {
    const now = seconds(2_000_000_000)
    const range = (age: number, width = age) => ({
      fromSeconds: seconds(now - age),
      toSeconds: seconds(now - age + width),
    })

    expect(selectTelemetryHistoryResolution(range(6 * 3_600), now)).toBe(60)
    expect(selectTelemetryHistoryResolution(range(24 * 3_600), now)).toBe(300)
    expect(selectTelemetryHistoryResolution(range(7 * 86_400), now)).toBe(900)
    expect(selectTelemetryHistoryResolution(range(30 * 86_400), now)).toBe(3_600)
    expect(selectTelemetryHistoryResolution(range(60 * 86_400), now)).toBe(21_600)

    expect(selectTileHistoryResolution(range(12 * 3_600), now)).toBe(0)
    expect(selectTileHistoryResolution(range(3 * 86_400), now)).toBe(3_600)
    expect(selectTileHistoryResolution(range(14 * 86_400), now)).toBe(21_600)
    expect(selectTileHistoryResolution(range(60 * 86_400), now)).toBe(86_400)
    expect(
      selectTileHistoryResolution(
        {
          fromSeconds: seconds(now - 20 * 86_400),
          toSeconds: seconds(now - 20 * 86_400 + 3_600),
        },
        now,
      ),
    ).toBe(21_600)
  })

  it('maps a typed status read failure to the existing 500 response', async () => {
    const { app, sql } = await harness()
    const readToken = await mintToken(app, 'read')
    const error = new Error('database unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    sql.readTemplateStatuses = async () => {
      throw error
    }

    const response = await app.request('/telemetry/status?season=0', {
      headers: bearer(readToken),
    })

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(consoleError).toHaveBeenCalledWith(error)
  })

  it('reuses one revisioned projection while keeping public and admin status scopes separate', async () => {
    const { app, sql } = await harness()
    const draftId = await createTemplate(app, false)
    const readToken = await mintToken(app, 'read')
    const aggregate = vi.spyOn(sql, 'readTemplateStatuses')
    await uploadCanvasTile(app, BOOTSTRAP, 1_750_032_000)

    const publicFirst = await app.request('/telemetry/status?season=0', {
      headers: bearer(readToken),
    })
    const publicAgain = await app.request('/telemetry/status?season=0', {
      headers: bearer(readToken),
    })
    const admin = await app.request('/telemetry/status?season=0', {
      headers: bearer(BOOTSTRAP),
    })

    await expect(publicFirst.json()).resolves.toEqual({ revision: 2, templates: [] })
    await expect(publicAgain.json()).resolves.toEqual({ revision: 2, templates: [] })
    await expect(admin.json()).resolves.toMatchObject({
      revision: 2,
      templates: [{ templateId: draftId }],
    })
    // The committed upload materializes both scopes once; three reads do no D1 aggregation.
    expect(aggregate).toHaveBeenCalledTimes(2)

    const published = await app.request(`/admin/templates/${draftId}`, {
      method: 'PATCH',
      headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
    expect(published.status).toBe(200)
    const publicAfterPublish = await app.request('/telemetry/status?season=0', {
      headers: bearer(readToken),
    })
    await expect(publicAfterPublish.json()).resolves.toMatchObject({
      revision: 3,
      templates: [{ templateId: draftId }],
    })
    expect(aggregate).toHaveBeenCalledTimes(4)
  })

  it('serves the server-classified mismatch mask for one visible template tile', async () => {
    const { app, blobs, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const readToken = await mintToken(app, 'read')
    const canvasHash = await uploadCanvasTile(app, reportToken, 1_750_032_000)
    const manifestResponse = await app.request('/manifest?season=0', {
      headers: bearer(readToken),
    })
    const manifest = (await manifestResponse.json()) as {
      templates: readonly { id: string; version: string }[]
    }
    const version = manifest.templates.find((template) => template.id === templateId)?.version
    expect(version).toBeDefined()
    if (version === undefined) throw new Error('template version missing')
    const artifactKey = mismatchArtifactKey({
      templateId,
      versionId: version,
      tile: { x: 0, y: 0 },
      canvasHash,
    })
    await expect(blobs.get('derived', artifactKey)).resolves.not.toBeNull()
    await expect(sql.readTemplateStatuses(0, false)).resolves.toEqual([
      expect.objectContaining({
        templateId,
        correct: 1,
        blank: 1,
        wrong: 1,
        colours: [
          { index: 0, correct: 1, wrong: 0, blank: 0, total: 1 },
          { index: 1, correct: 0, wrong: 0, blank: 1, total: 1 },
          { index: 2, correct: 0, wrong: 1, blank: 0, total: 1 },
        ],
      }),
    ])

    // Simulate isolate loss and unavailable raw inputs. Normal reads still use the immutable
    // artifact produced by the same ingestion pass as the progress and colour totals above.
    decodedPixelCache.clear()
    const chunks = await blobs.list('chunks', { limit: 10 })
    await blobs.delete('chunks', chunks.keys)
    const tileObject = await sql.readTileBlob(canvasHash)
    if (tileObject !== null) await blobs.delete('tiles', [tileObject.blobKey])

    const response = await app.request(
      `/telemetry/templates/${templateId}/versions/${version}/tiles/0/0/mismatches?season=0`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(
      'application/vnd.caelestis.mismatch-mask',
    )
    const mask = decodeMismatchMask(new Uint8Array(await response.arrayBuffer()))
    expect(mask).not.toBeNull()
    expect(mask && mismatchClassAt(mask, 0, 0)).toBe(MATCH)
    expect(mask && mismatchClassAt(mask, 1, 0)).toBe(BLANK)
    expect(mask && mismatchClassAt(mask, 2, 0)).toBe(WRONG)
  })

  it('rebuilds and persists a missing derived mismatch artifact from authoritative raw inputs', async () => {
    const { app, blobs } = await harness()
    const templateId = await createPublishedTemplate(app)
    const reportToken = await mintToken(app, 'report')
    const readToken = await mintToken(app, 'read')
    const canvasHash = await uploadCanvasTile(app, reportToken, 1_750_032_000)
    const manifest = (await (
      await app.request('/manifest?season=0', { headers: bearer(readToken) })
    ).json()) as { templates: readonly { id: string; version: string }[] }
    const versionId = manifest.templates.find((template) => template.id === templateId)?.version
    if (versionId === undefined) throw new Error('template version missing')
    const artifactKey = mismatchArtifactKey({
      templateId,
      versionId,
      tile: { x: 0, y: 0 },
      canvasHash,
    })
    await blobs.delete('derived', [artifactKey])
    decodedPixelCache.clear()

    const response = await app.request(
      `/telemetry/templates/${templateId}/versions/${versionId}/tiles/0/0/mismatches?season=0`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    await expect(blobs.get('derived', artifactKey)).resolves.not.toBeNull()
  })

  it('serves folded pace history over a half-open range', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    await sql.appendBuckets([
      {
        templateId,
        resolution: 60,
        bucketStart: seconds(1_749_988_800),
        placed: 5,
        correct: 4,
        repairs: 1,
      },
      {
        templateId,
        resolution: 60,
        bucketStart: seconds(1_749_988_860),
        placed: 2,
        correct: 2,
        repairs: 0,
      },
    ])

    const response = await app.request(
      `/telemetry/history?templateIds=${templateId}&resolution=60&from=1749988800&to=1749988860`,
      { headers: bearer(readToken) },
    )
    expect(response.status).toBe(200)
    // Half-open: the bucket starting exactly at `to` is excluded.
    await expect(response.json()).resolves.toEqual({
      buckets: [
        {
          templateId,
          resolution: 60,
          bucketStart: 1_749_988_800,
          placed: 5,
          correct: 4,
          repairs: 1,
        },
      ],
    })
  })

  it('accepts history reads without a client-selected tier', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const now = Math.floor(Date.now() / 1_000)
    const bucketStart = Math.floor((now - 60) / 60) * 60
    await sql.appendBuckets([
      {
        templateId,
        resolution: 60,
        bucketStart: seconds(bucketStart),
        placed: 1,
        correct: 1,
        repairs: 0,
      },
    ])

    const response = await app.request(
      `/telemetry/history?templateIds=${templateId}&from=${now - 3_600}&to=${now}`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      buckets: [expect.objectContaining({ templateId, resolution: 60, bucketStart })],
    })
  })

  it('serves only the retained fine part when a pace window bounds bucket width', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const now = Math.floor(Date.now() / 1_000)
    const to = Math.floor(now / 3_600) * 3_600
    const from = to - 8 * 86_400
    await sql.appendBuckets([
      {
        templateId,
        resolution: 3_600,
        bucketStart: seconds(from),
        placed: 7,
        correct: 6,
        repairs: 1,
      },
      {
        templateId,
        resolution: 900,
        bucketStart: seconds(to - 900),
        placed: 2,
        correct: 2,
        repairs: 0,
      },
    ])

    const response = await app.request(
      `/telemetry/history?templateIds=${templateId}&maxResolution=900&from=${from}&to=${to}`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      resolution: 900,
      coverageStart: to - 7 * 86_400,
      buckets: [
        {
          templateId,
          resolution: 900,
          bucketStart: to - 900,
          placed: 2,
          correct: 2,
          repairs: 0,
        },
      ],
    })
  })

  it('coalesces finer retained telemetry when the selected coarse tier is not materialised', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const now = Math.floor(Date.now() / 1_000)
    const to = Math.floor(now / 21_600) * 21_600
    const from = to - 60 * 86_400
    await sql.appendBuckets([
      {
        templateId,
        resolution: 60,
        bucketStart: seconds(from),
        placed: 7,
        correct: 6,
        repairs: 2,
      },
    ])

    const response = await app.request(
      `/telemetry/history?templateIds=${templateId}&from=${from}&to=${to}`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      buckets: [
        {
          templateId,
          resolution: 21_600,
          bucketStart: from,
          placed: 7,
          correct: 6,
          repairs: 2,
        },
      ],
    })
  })

  it('rejects malformed history queries and unauthenticated readers', async () => {
    const { app } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const query = (params: string) =>
      app.request(`/telemetry/history?${params}`, { headers: bearer(readToken) })

    expect((await query(`resolution=60&from=1&to=2`)).status).toBe(400)
    expect((await query(`templateIds=not-a-uuid&resolution=60&from=1&to=2`)).status).toBe(400)
    expect((await query(`templateIds=${templateId}&resolution=61&from=1&to=2`)).status).toBe(400)
    expect((await query(`templateIds=${templateId}&maxResolution=59&from=1&to=2`)).status).toBe(400)
    expect(
      (await query(`templateIds=${templateId}&resolution=60&maxResolution=900&from=1&to=2`)).status,
    ).toBe(400)
    expect((await query(`templateIds=${templateId}&resolution=60&from=2&to=2`)).status).toBe(400)
    expect((await query(`templateIds=${templateId}&resolution=60&from=2&to=1`)).status).toBe(400)
    expect((await query(`templateIds=${templateId}&resolution=60&from=x&to=2`)).status).toBe(400)

    const unauthenticated = await app.request(
      `/telemetry/history?templateIds=${templateId}&resolution=60&from=1&to=2`,
    )
    expect(unauthenticated.status).toBe(401)
  })

  it('never double-credits a painter-day two reporters both described', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    await sql.rememberPainter(7, 'Mia', millis(Date.now()))
    await sql.addContributions([
      contribution({ templateId, reportedByUserId: 1, placed: 10, correct: 8, repairs: 2 }),
      contribution({ templateId, reportedByUserId: 2, placed: 6, correct: 6, repairs: 3 }),
    ])

    const response = await app.request(
      `/telemetry/contributions?templateIds=${templateId}&from=${DAY}&to=${NEXT_DAY}`,
      { headers: bearer(readToken) },
    )
    expect(response.status).toBe(200)
    // MAX per counter across the two reporter rows — not the 16/14/5 a SUM would fabricate.
    await expect(response.json()).resolves.toEqual({
      days: [
        {
          templateId,
          day: DAY,
          wplaceUserId: 7,
          displayName: 'Mia',
          placed: 10,
          correct: 8,
          repairs: 3,
        },
      ],
    })

    const missingRange = await app.request(`/telemetry/contributions?templateIds=${templateId}`, {
      headers: bearer(readToken),
    })
    expect(missingRange.status).toBe(400)
    const unauthenticated = await app.request(
      `/telemetry/contributions?templateIds=${templateId}&from=${DAY}&to=${NEXT_DAY}`,
    )
    expect(unauthenticated.status).toBe(401)
  })

  it('ranks painters by de-duplicated totals with active days and a last day', async () => {
    const { app, sql } = await harness()
    const templateId = await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    await sql.rememberPainter(7, 'Mia', millis(Date.now()))
    await sql.rememberPainter(9, 'Kess', millis(Date.now()))
    await sql.addContributions([
      // Painter 7's first day, seen by two reporters — counted once.
      contribution({ templateId, wplaceUserId: 7, reportedByUserId: 1 }),
      contribution({ templateId, wplaceUserId: 7, reportedByUserId: 2 }),
      contribution({
        templateId,
        wplaceUserId: 7,
        day: NEXT_DAY,
        placed: 3,
        correct: 3,
        repairs: 0,
      }),
      contribution({ templateId, wplaceUserId: 9, placed: 20, correct: 5, repairs: 0 }),
    ])

    const response = await app.request('/telemetry/leaderboard?season=0', {
      headers: bearer(readToken),
    })
    expect(response.status).toBe(200)
    // Sorted by correct descending — painter 9 placed more but corrected less.
    await expect(response.json()).resolves.toEqual({
      entries: [
        {
          wplaceUserId: 7,
          displayName: 'Mia',
          placed: 13,
          correct: 11,
          repairs: 2,
          activeDays: 2,
          lastDay: NEXT_DAY,
        },
        {
          wplaceUserId: 9,
          displayName: 'Kess',
          placed: 20,
          correct: 5,
          repairs: 0,
          activeDays: 1,
          lastDay: DAY,
        },
      ],
    })

    const limited = await app.request('/telemetry/leaderboard?season=0&limit=1', {
      headers: bearer(readToken),
    })
    const { entries } = (await limited.json()) as { entries: { wplaceUserId: number }[] }
    expect(entries).toHaveLength(1)
    expect(entries[0]?.wplaceUserId).toBe(7)

    expect(
      (
        await app.request('/telemetry/leaderboard?season=0&limit=201', {
          headers: bearer(readToken),
        })
      ).status,
    ).toBe(400)
    expect(
      (await app.request('/telemetry/leaderboard?season=-1', { headers: bearer(readToken) }))
        .status,
    ).toBe(400)
    expect((await app.request('/telemetry/leaderboard?season=0')).status).toBe(401)
  })

  it("hides an unpublished template's telemetry from read scope on every id-taking route", async () => {
    const { app, sql } = await harness()
    const templateId = await createTemplate(app, false)
    const readToken = await mintToken(app, 'read')
    await sql.rememberPainter(7, 'Mia', millis(Date.now()))
    await sql.appendBuckets([
      {
        templateId,
        resolution: 60,
        bucketStart: seconds(1_749_988_800),
        placed: 5,
        correct: 4,
        repairs: 1,
      },
    ])
    await sql.addContributions([contribution({ templateId })])

    // A read-scoped caller holding the id — say from a manifest poll made before the template was
    // unpublished — gets empty results, indistinguishable from an id that names nothing.
    const history = (params = '') =>
      app.request(
        `/telemetry/history?templateIds=${templateId}&resolution=60&from=1749988800&to=1749988900`,
        { headers: bearer(params === 'admin' ? BOOTSTRAP : readToken) },
      )
    await expect((await history()).json()).resolves.toEqual({ buckets: [] })

    const contributions = (token: string) =>
      app.request(`/telemetry/contributions?templateIds=${templateId}&from=${DAY}&to=${NEXT_DAY}`, {
        headers: bearer(token),
      })
    await expect((await contributions(readToken)).json()).resolves.toEqual({ days: [] })

    const leaderboard = (token: string) =>
      app.request('/telemetry/leaderboard?season=0', { headers: bearer(token) })
    await expect((await leaderboard(readToken)).json()).resolves.toEqual({ entries: [] })

    // The admin gate is the same one the manifest applies: full visibility.
    const adminHistory = (await (await history('admin')).json()) as { buckets: unknown[] }
    expect(adminHistory.buckets).toHaveLength(1)
    const adminDays = (await (await contributions(BOOTSTRAP)).json()) as { days: unknown[] }
    expect(adminDays.days).toHaveLength(1)
    const adminEntries = (await (await leaderboard(BOOTSTRAP)).json()) as { entries: unknown[] }
    expect(adminEntries.entries).toHaveLength(1)
  })

  it('lists current canvas tiles and serves each frame of a tile timelapse', async () => {
    const { app } = await harness()
    await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const reportToken = await mintToken(app, 'report')
    const now = Math.floor(Date.now() / 1_000)
    const hash = await uploadCanvasTile(app, reportToken, now)

    const canvas = await app.request('/telemetry/canvas?season=0', {
      headers: bearer(readToken),
    })
    expect(canvas.status).toBe(200)
    await expect(canvas.json()).resolves.toEqual({
      tiles: [{ tile: '0/0', hash, observedAt: now * 1_000 }],
    })

    const history = await app.request(
      `/telemetry/tiles/0/0/history?season=0&resolution=0&from=${now - 3_600}&to=${now + 3_600}`,
      { headers: bearer(readToken) },
    )
    expect(history.status).toBe(200)
    const { frames } = (await history.json()) as {
      frames: { bucketStart: number; hash: string; reporters: number }[]
    }
    expect(frames).toEqual([{ bucketStart: expect.any(Number), hash, reporters: 1 }])

    const badResolution = await app.request(
      `/telemetry/tiles/0/0/history?season=0&resolution=61&from=${now - 1}&to=${now + 1}`,
      { headers: bearer(readToken) },
    )
    expect(badResolution.status).toBe(400)
    const offCanvas = await app.request(
      `/telemetry/tiles/2048/0/history?season=0&resolution=0&from=${now - 1}&to=${now + 1}`,
      { headers: bearer(readToken) },
    )
    expect(offCanvas.status).toBe(400)
    const unauthenticated = await app.request(
      `/telemetry/tiles/0/0/history?season=0&resolution=0&from=${now - 1}&to=${now + 1}`,
    )
    expect(unauthenticated.status).toBe(401)
  })

  it('coalesces preserved raw tile history when an old range selects the permanent tier', async () => {
    const { app, sql } = await harness()
    const readToken = await mintToken(app, 'read')
    const now = Math.floor(Date.now() / 1_000)
    const to = Math.floor(now / 86_400) * 86_400
    const from = to - 60 * 86_400
    const hash = 'b'.repeat(64)
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 0, y: 0 },
        hash,
        observedAt: millis(from * 1_000),
        reportedAt: seconds(from),
        reportedWithToken: TOKEN_DIGEST,
        reportedByUserId: 1,
      },
      [],
    )

    const response = await app.request(
      `/telemetry/tiles/0/0/history?season=0&from=${from}&to=${to}`,
      { headers: bearer(readToken) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      frames: [{ bucketStart: from, hash, reporters: 1 }],
    })
  })

  it('serves mirrored tile blobs by hash like template chunks', async () => {
    const { app, blobs, sql } = await harness()
    await createPublishedTemplate(app)
    const readToken = await mintToken(app, 'read')
    const reportToken = await mintToken(app, 'report')
    const hash = await uploadCanvasTile(app, reportToken, Math.floor(Date.now() / 1_000))

    const response = await app.request(`/tiles/${hash}`, { headers: bearer(readToken) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await sha256Hex(new Uint8Array(await response.arrayBuffer()))).toBe(hash)
    const object = await sql.readTileBlob(hash)
    expect(object?.blobKey).toMatch(new RegExp(`^${hash}/`))
    await expect(blobs.hasAll('tiles', [hash, object?.blobKey ?? 'missing'])).resolves.toEqual(
      new Set([object?.blobKey]),
    )

    const absent = await app.request(`/tiles/${'b'.repeat(64)}`, { headers: bearer(readToken) })
    expect(absent.status).toBe(404)
    await expect(absent.json()).resolves.toEqual({ error: 'not found' })
    expect((await app.request('/tiles/not-a-hash', { headers: bearer(readToken) })).status).toBe(
      400,
    )
    expect((await app.request(`/tiles/${hash}`)).status).toBe(401)
  })
})
