// @vitest-environment happy-dom
import {
  encodeIndexedPng,
  millis,
  sha256Hex,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ArchiveSource,
  type BackfillStorage,
  TemplateBackfill,
} from '../../../backend/dist/backfill/import.js'
import { type BackfillClients, backfillReply } from '../../../backend/dist/backfill/port.js'
import {
  type ApiError,
  chunkImageUrl,
  getAlarms,
  getArchiveHistory,
  getCanvas,
  getContributions,
  getHistory,
  getLeaderboard,
  getManifest,
  getPainterHistory,
  getPainterTotals,
  getProgressHistory,
  getServer,
  getStatus,
  getTileHistory,
  tileImageUrl,
  writeConnection,
} from '../lib/api/client'
import { adminToken, authorized, createTestBackend, frontendFetch } from './backend'

const fixtureNow = 1_700_010_000
const range = { from: fixtureNow - 172_800, to: fixtureNow + 3_600 }

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

class MemoryBackfillStorage implements BackfillStorage {
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => [key, value as T]),
    )
  }

  async setAlarm(_at: number): Promise<void> {}
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(fixtureNow * 1_000)
  localStorage.clear()
  writeConnection('https://backend.test', adminToken)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const createPublishedTemplate = async (backfillClients?: BackfillClients) => {
  const backend = await createTestBackend({
    openAccess: true,
    clock: () => millis(fixtureNow * 1_000),
    ...(backfillClients === undefined ? {} : { backfillClients }),
  })
  const nodeResponse = await backend.app.fetch(
    authorized('/admin/nodes', {
      method: 'POST',
      ...json({ season: 3, parentId: null, name: 'Boundary folder' }),
    }),
  )
  expect(nodeResponse.status).toBe(201)
  const node = (await nodeResponse.json()) as { id: string }

  const artwork = await encodeIndexedPng(1, 1, new Uint8Array([1]))
  const form = new FormData()
  form.set('png', new File([Uint8Array.from(artwork)], 'boundary.png', { type: 'image/png' }))
  form.set('nodeId', node.id)
  form.set('name', 'Boundary artwork')
  form.set('originX', '4')
  form.set('originY', '8')
  const templateResponse = await backend.app.fetch(
    authorized('/admin/templates', { method: 'POST', body: form }),
  )
  expect(templateResponse.status).toBe(201)
  const template = (await templateResponse.json()) as {
    templateId: string
    versionId: string
    chunks: readonly { hash: string }[]
  }

  const publication = await backend.app.fetch(
    authorized(`/admin/templates/${template.templateId}`, {
      method: 'PATCH',
      ...json({ published: true, name: 'Published boundary artwork' }),
    }),
  )
  expect(publication.status).toBe(200)
  return { backend, node, template }
}

const seedTelemetry = async (
  backend: Awaited<ReturnType<typeof createTestBackend>>,
  template: { readonly templateId: string },
) => {
  const upload = async (indices: Uint8Array, observedAt: number) => {
    const canvas = await encodeIndexedPng(1_000, 1_000, indices)
    const hash = await sha256Hex(canvas)
    const uploaded = await backend.app.fetch(
      authorized(`/telemetry/tiles/0/0/${hash}`, {
        method: 'PUT',
        headers: {
          'content-type': 'image/png',
          'x-caelestis-season': '3',
          'x-caelestis-observed-at': String(observedAt),
          'x-caelestis-wplace-user-id': '42',
          'x-caelestis-display-name': 'Boundary%20Painter',
        },
        body: Uint8Array.from(canvas),
      }),
    )
    expect(uploaded.status).toBe(200)
    return { canvas, hash }
  }

  const correct = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
  correct[8_004] = 1
  const observedAt = fixtureNow - 600
  const initial = await upload(correct, observedAt)
  await backend.blobs.put('archives', initial.hash, initial.canvas)
  const painted = await backend.app.fetch(
    authorized('/telemetry/paints', {
      method: 'POST',
      ...json({
        eventId: '01890f3e-7b2c-7abc-8def-012345678901',
        wplaceUserId: 42,
        displayName: 'Boundary Painter',
        season: 3,
        ts: observedAt,
        tiles: [{ x: 0, y: 0, pixels: { x: [4], y: [8], colors: [2] } }],
        painted: 1,
      }),
    }),
  )
  expect(painted.status).toBe(200)
  expect(await painted.json()).toMatchObject({ accepted: true, partial: false })
  await backend.counters.alarm()

  const regression = await upload(
    new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX),
    observedAt + 300,
  )
  return { hash: regression.hash, initialHash: initial.hash, templateId: template.templateId }
}

const archiveTemplateId = '01890f3e-7b2c-7abc-8def-012345678911'
const archiveVersionId = '01890f3e-7b2c-7abc-8def-012345678912'
const archiveSnapshot = { id: 7, at: fixtureNow - 7_200 }

const backfillClients = () => {
  const importers = new Map<string, TemplateBackfill>()
  const client: BackfillClients = (templateId) => {
    const importer = importers.get(templateId)
    if (importer === undefined) throw new Error(`Archive importer is not ready for ${templateId}`)
    return {
      preview: (id) => backfillReply(() => importer.preview(id)),
      job: () => backfillReply(() => importer.job()),
      history: (version, tile) => backfillReply(() => importer.history(version, tile)),
      start: (id, version, snapshot) => backfillReply(() => importer.start(id, version, snapshot)),
      cancel: () => backfillReply(() => importer.cancel()),
    }
  }
  return { client, importers }
}

const seedArchive = async (backend: Awaited<ReturnType<typeof createTestBackend>>) => {
  const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
  const chunkHash = await sha256Hex(chunk)
  await backend.blobs.put('chunks', chunkHash, chunk)
  await backend.sql.insertTemplateVersion({
    templateId: archiveTemplateId,
    versionId: archiveVersionId,
    surface: WORLD_TEMPLATE_SURFACE,
    season: 0,
    nodeId: null,
    name: 'Archived boundary artwork',
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    createdAt: millis(fixtureNow * 1_000),
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: chunkHash }],
  })
  const pixels = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
  pixels[0] = 1
  const source: ArchiveSource = {
    snapshots: async () => [archiveSnapshot],
    tile: async () => pixels,
  }
  return new TemplateBackfill(
    new MemoryBackfillStorage(),
    backend.sql,
    backend.blobs,
    source,
    () => fixtureNow * 1_000,
  )
}

describe('frontend API client against the built backend', () => {
  it('reads a published template lifecycle and authenticated chunk through its browser transport', async () => {
    const { backend, node, template } = await createPublishedTemplate()
    const requests: Request[] = []
    vi.stubGlobal('fetch', frontendFetch(backend.app, requests))
    const objectUrl = vi.fn(() => 'blob:boundary-artwork')
    vi.spyOn(URL, 'createObjectURL').mockImplementation(objectUrl)

    const manifest = await getManifest(3)
    expect(manifest.nodes).toContainEqual(expect.objectContaining({ id: node.id }))
    expect(manifest.templates).toContainEqual(
      expect.objectContaining({ id: template.templateId, name: 'Published boundary artwork' }),
    )
    await expect(chunkImageUrl(template.chunks[0]?.hash ?? '')).resolves.toBe(
      'blob:boundary-artwork',
    )
    expect(requests.map((request) => request.url)).toEqual([
      'https://backend.test/v1/manifest?season=3',
      `https://backend.test/v1/chunks/${template.chunks[0]?.hash}`,
    ])
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${adminToken}`)
  })

  it('reads populated telemetry from real canvas and paint reports', async () => {
    const { backend, template } = await createPublishedTemplate()
    const telemetry = await seedTelemetry(backend, template)
    vi.stubGlobal('fetch', frontendFetch(backend.app))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:boundary-canvas')

    const templateIds = [template.templateId]
    const [
      status,
      alarms,
      progress,
      history,
      totals,
      painterHistory,
      contributions,
      leaderboard,
      canvas,
      tiles,
    ] = await Promise.all([
      getStatus(3),
      getAlarms(3),
      getProgressHistory(template.templateId, template.versionId, range.from, range.to),
      getHistory(templateIds, range.from, range.to, { maxResolution: 60 }),
      getPainterTotals(templateIds, range.from, range.to, { limit: 10 }),
      getPainterHistory(templateIds, [42], range.from, range.to, { maxResolution: 60 }),
      getContributions(templateIds, range.from, range.to),
      getLeaderboard(3, { templateIds, from: range.from, to: range.to, limit: 10 }),
      getCanvas(3),
      getTileHistory(0, 0, 3, range.from, range.to),
    ])

    expect(status.templates).toContainEqual(
      expect.objectContaining({ templateId: template.templateId, correct: 0, blank: 1, total: 1 }),
    )
    expect(alarms.alarms).toContainEqual(
      expect.objectContaining({
        templateId: template.templateId,
        kind: 'regression',
        pixelsLost: 1,
      }),
    )
    expect(progress.versionId).toBe(template.versionId)
    expect(progress.samples).toContainEqual(expect.objectContaining({ correct: 0, total: 1 }))
    expect(history.buckets).toContainEqual(
      expect.objectContaining({ templateId: template.templateId, placed: 1, correct: 1 }),
    )
    expect(totals.painters).toContainEqual(
      expect.objectContaining({ wplaceUserId: 42, displayName: 'Boundary Painter', correct: 1 }),
    )
    expect(painterHistory.buckets).toContainEqual(
      expect.objectContaining({ templateId: template.templateId, wplaceUserId: 42, correct: 1 }),
    )
    expect(contributions.days).toContainEqual(
      expect.objectContaining({ templateId: template.templateId, wplaceUserId: 42, correct: 1 }),
    )
    expect(leaderboard.entries).toContainEqual(
      expect.objectContaining({ wplaceUserId: 42, displayName: 'Boundary Painter', correct: 1 }),
    )
    expect(canvas.tiles).toContainEqual(
      expect.objectContaining({ tile: '0/0', hash: telemetry.hash }),
    )
    expect(tiles.frames).toContainEqual(expect.objectContaining({ hash: telemetry.hash }))
    await expect(tileImageUrl(telemetry.initialHash)).resolves.toBe('blob:boundary-canvas')
    await expect(tileImageUrl(`archive:${telemetry.initialHash}`)).resolves.toBe(
      'blob:boundary-canvas',
    )

    await expect(getTileHistory(-1, 0, 3, range.from, range.to)).rejects.toMatchObject({
      status: 400,
      message: 'tile coordinates must be on the canvas',
    } satisfies Partial<ApiError>)
  })

  it('reflects admin changes through client reads and keeps archive compatibility', async () => {
    const backfill = backfillClients()
    const { backend, template } = await createPublishedTemplate(backfill.client)
    const importer = await seedArchive(backend)
    backfill.importers.set(archiveTemplateId, importer)
    const job = await importer.start(archiveTemplateId, archiveVersionId, archiveSnapshot.id)
    for (let step = 0; step < job.total; step += 1) await importer.step()
    const denied = await backend.app.fetch(
      new Request('https://backend.test/admin/server', {
        method: 'PATCH',
        ...json({ name: 'Denied server' }),
      }),
    )
    expect(denied.status).toBe(401)
    const renamed = await backend.app.fetch(
      authorized('/admin/server', { method: 'PATCH', ...json({ name: 'Boundary server' }) }),
    )
    expect(renamed.status).toBe(200)
    vi.stubGlobal('fetch', frontendFetch(backend.app))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive-frame')

    await expect(getServer()).resolves.toMatchObject({ name: 'Boundary server' })
    await expect(getArchiveHistory(archiveTemplateId, archiveVersionId)).resolves.toMatchObject({
      basis: { templateId: archiveTemplateId, versionId: archiveVersionId },
      samples: [{ snapshotId: archiveSnapshot.id, correct: 1, mismatched: 0, total: 1 }],
    })
    const frames = await getArchiveHistory(archiveTemplateId, archiveVersionId, { x: 0, y: 0 })
    expect(frames.frames).toHaveLength(1)
    const hash = frames.frames[0]?.hash
    if (hash === null || hash === undefined)
      throw new Error('Archive importer did not persist a frame')
    await expect(tileImageUrl(`archive:${hash}`)).resolves.toBe('blob:archive-frame')
    await expect(
      getArchiveHistory('01890f3e-7b2c-7abc-8def-012345678901', template.versionId),
    ).resolves.toEqual({
      source: 'eralyon',
      basis: null,
      samples: [],
      frames: [],
    })
    await expect(tileImageUrl(`archive:${'b'.repeat(64)}`)).rejects.toMatchObject({ status: 404 })
  })
})
