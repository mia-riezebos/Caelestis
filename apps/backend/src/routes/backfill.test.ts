import { type BackfillJob, type BackfillPreview, millis } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { BackfillError } from '../backfill/import.js'
import { backfillReply } from '../backfill/port.js'
import { measureRequest } from '../metrics/request-metrics.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'

const ID = '01890f3e-7b2c-7abc-8def-0123456789ab'
const VERSION = '01890f3e-7b2c-7abc-8def-0123456789ac'
const admin = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }

const harness = async () => {
  const sql = new MemorySqlStore(),
    blobs = new MemoryBlobStore()
  await sql.insertTemplateVersion({
    templateId: ID,
    versionId: VERSION,
    season: 0,
    nodeId: null,
    name: 'Test',
    surface: { kind: 'world', allianceId: null },
    createdAt: millis(300_000),
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
  })
  const preview: BackfillPreview = {
    basis: {
      templateId: ID,
      versionId: VERSION,
      name: 'Test',
      season: 0,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      total: 1,
      chunks: [],
    },
    snapshots: [{ id: 1, at: 100 }],
    end: 200,
    tileCount: 1,
    job: null,
  }
  const job: BackfillJob = {
    id: 'job',
    basis: preview.basis,
    from: 100,
    to: 100,
    status: 'running',
    completed: 0,
    total: 1,
    imported: 0,
    skipped: 0,
    failed: 0,
    error: null,
  }
  const start = vi.fn(async () => backfillReply(async () => job))
  const client = {
    preview: async () => backfillReply(async () => preview),
    start,
    job: async () => backfillReply(async () => job),
    cancel: async () => backfillReply(async () => ({ ...job, status: 'cancelled' as const })),
    history: async () =>
      backfillReply(async () => ({
        source: 'eralyon' as const,
        basis: preview.basis,
        samples: [],
        frames: [],
      })),
  }
  const app = createApp(makeBackendContext(blobs, sql, new MemoryCounterStore(sql)), {
    bootstrapAdminToken: 'admin-token',
    openAccess: true,
    backfillClients: () => client,
  })
  return { app, sql, start, client }
}

it('gates every backfill operation to admins and validates before dispatch', async () => {
  const { app, start } = await harness()
  for (const [path, method] of [
    ['preview', 'GET'],
    ['job', 'GET'],
    ['start', 'POST'],
    ['cancel', 'POST'],
  ] as const) {
    expect((await app.request(`/v1/admin/backfill/${ID}/${path}`, { method })).status).toBe(401)
  }
  expect(
    (
      await app.request(`/v1/admin/backfill/${ID}/start`, {
        method: 'POST',
        headers: admin,
        body: '{}',
      })
    ).status,
  ).toBe(400)
  expect(start).not.toHaveBeenCalled()
  const response = await app.request(`/v1/admin/backfill/${ID}/start`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ versionId: VERSION, snapshotId: 1 }),
  })
  expect(response.status).toBe(200)
  expect(start).toHaveBeenCalledWith(ID, VERSION, 1)
})

it('hides unpublished archive history and rejects invalid tile coordinates', async () => {
  const { app, sql } = await harness()
  expect((await app.request(`/v1/archive/templates/${ID}`)).status).toBe(404)
  await sql.setTemplatePublishedAt(ID, millis(400_000), millis(400_000))
  expect((await app.request(`/v1/archive/templates/${ID}`)).status).toBe(200)
  expect((await app.request(`/v1/archive/templates/${ID}?x=2048&y=0`)).status).toBe(400)
  expect((await app.request(`/v1/archive/templates/${ID}?x=1`)).status).toBe(400)
})

it.each([false, true])(
  'attributes remote backfill D1 usage to successful and failed HTTP requests (%s)',
  async (fail) => {
    const { app, client } = await harness()
    const reply = fail
      ? await backfillReply<BackfillPreview>(async () => {
          throw new BackfillError('Artwork changed', 409)
        })
      : await client.preview()
    client.preview = async () => ({
      ...reply,
      usage: { rowsRead: 17, rowsWritten: 0, measuredQueries: 2, unmeasuredQueries: 1 },
    })
    const writeDataPoint = vi.fn()
    const request = new Request(`https://example.com/v1/admin/backfill/${ID}/preview`, {
      headers: admin,
    })
    const response = await measureRequest(
      { writeDataPoint },
      request,
      '/v1/admin/backfill/:templateId/preview',
      async () => app.fetch(request),
    )
    expect(response.status).toBe(fail ? 409 : 200)
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles.slice(2, 6)).toEqual([17, 0, 2, 1])
  },
)
