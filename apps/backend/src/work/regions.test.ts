import {
  MAX_PRESENCE_REGIONS,
  MAX_RASTER_BITS,
  millis,
  packBits,
  type RegionClaim,
  type RegionDocument,
  type RegionShape,
  regionDocumentBounds,
  uuidV7,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { RegionClaim as RegionClaimSchema } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'

const actor = { wplaceUserId: 1, displayName: 'Mia' }
const other = { wplaceUserId: 2, displayName: 'Dawn' }
const star: RegionShape = { kind: 'star', cx: 30, cy: 40, r: 20, inner: 8, points: 5, rotation: 90 }
const rectangle: RegionShape = { kind: 'rectangle', x: 0, y: 0, w: 8, h: 8 }
const documentOf = (shape: RegionShape): RegionDocument => ({
  items: [{ id: 'shape', shape, op: 'add' }],
})
const document: RegionDocument = {
  items: [
    { id: 'star', shape: star, op: 'add' },
    {
      id: 'cutout',
      shape: { kind: 'rectangle', x: 1_000, y: 1_000, w: 8, h: 8 },
      op: 'subtract',
    },
    {
      id: 'stroke',
      shape: {
        kind: 'path',
        nodes: [
          { x: 60.5, y: 70.25, out: { x: 90.75, y: 80 } },
          { x: 100, y: 110, in: { x: 95, y: 120.5 } },
        ],
        closed: false,
        width: 3.5,
      },
      op: 'add',
    },
  ],
}
let database: SqliteD1Database | undefined
afterEach(() => {
  database?.close()
  database = undefined
})

const setup = async (adapter: 'memory' | 'd1') => {
  if (adapter === 'd1') database = new SqliteD1Database()
  const sql =
    database === undefined
      ? new MemorySqlStore()
      : new D1SqlStore(database as unknown as D1Database)
  const publishRegions = vi.fn(async () => {})
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
      undefined,
      { publishRegions },
    ),
    { bootstrapAdminToken: 'admin' },
  )
  for (const scope of ['read', 'report'] as const)
    await sql.insertAccessToken({
      tokenHash: await hashToken(scope),
      label: scope,
      scope,
      createdWithToken: 'a'.repeat(64),
      createdAt: millis(Date.now()),
    })
  const templateId = uuidV7()
  await sql.insertTemplateVersion({
    templateId,
    versionId: uuidV7(),
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    nodeId: null,
    name: 'Box art',
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    createdAt: millis(Date.now()),
    bbox: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
  })
  const body = {
    templateId,
    actor,
    document: documentOf(rectangle),
    label: '',
  }
  const call = (method: string, id: string, body: unknown, token = 'report', query = 'season=0') =>
    app.request(`/v1/work/regions/${id}?${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { app, sql, publishRegions, body, call }
}

describe.each(['memory', 'd1'] as const)('region routes on %s', (adapter) => {
  it('creates, lists, replays identical requests, rejects conflicts, and publishes mutations', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, h.body)
    expect(response.status).toBe(200)
    const region = (await response.json()) as RegionClaim
    expect(region).toMatchObject({
      id,
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      templateId: h.body.templateId,
      claimant: actor,
      document: h.body.document,
      rect: regionDocumentBounds(h.body.document),
      label: '',
    })
    const replay = await h.call('PUT', id, h.body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(region)
    expect((await h.call('PUT', id, { ...h.body, actor: other })).status).toBe(409)
    const list = await h.app.request(`/work/regions?season=0&templateId=${h.body.templateId}`, {
      headers: { authorization: 'Bearer read' },
    })
    expect(await list.json()).toEqual({ regions: [region] })
    const absent = await h.app.request('/work/regions?season=1', {
      headers: { authorization: 'Bearer read' },
    })
    expect(await absent.json()).toEqual({ regions: [] })
    expect((await h.call('DELETE', id, { actor: other })).status).toBe(403)
    expect((await h.call('DELETE', id, { actor: other }, 'admin')).status).toBe(200)
    expect((await h.call('DELETE', id, { actor })).status).toBe(404)
    expect(h.publishRegions).toHaveBeenCalledTimes(3)
    expect(h.publishRegions).toHaveBeenLastCalledWith(0, WORLD_TEMPLATE_SURFACE)
  })

  it.each([{}, { templateId: null }])(
    'creates, lists, reads, and broadcasts a standalone claim with hint %j',
    async (hint) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const publications: unknown[] = []
      h.publishRegions.mockImplementation(async () => {
        publications.push(await h.sql.regions.listRegions(1, WORLD_TEMPLATE_SURFACE))
      })
      const response = await h.call(
        'PUT',
        id,
        { ...hint, actor, document, label: 'Canvas claim' },
        'report',
        'season=1',
      )
      expect(response.status).toBe(200)
      const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
      expect(region).toMatchObject({ id, season: 1, templateId: null, document })
      expect(await h.sql.regions.readRegion(id)).toEqual(region)
      const list = await h.app.request('/work/regions?season=1', {
        headers: { authorization: 'Bearer read' },
      })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({ regions: [region] })
      const filtered = await h.app.request(
        `/work/regions?season=1&templateId=${h.body.templateId}`,
        { headers: { authorization: 'Bearer read' } },
      )
      expect(await filtered.json()).toEqual({ regions: [] })
      expect(publications).toEqual([[region]])
      expect(h.publishRegions).toHaveBeenCalledExactlyOnceWith(1, WORLD_TEMPLATE_SURFACE)
      if (database !== undefined)
        expect(
          database.sqlite.prepare('SELECT template_id FROM work_regions WHERE id = ?').get(id),
        ).toEqual({ template_id: null })
    },
  )

  it('rejects a hint for a missing template', async () => {
    const h = await setup(adapter)
    const response = await h.call('PUT', uuidV7(), { ...h.body, templateId: uuidV7() })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Template is missing or belongs to another drawing surface',
    })
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('saves and updates a raster document with its mask and derived bounds', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    for (const shape of [
      {
        kind: 'pixels',
        x: 10,
        y: 20,
        w: 3,
        h: 3,
        mask: packBits(Uint8Array.of(1, 0, 1, 0, 1, 0, 1, 0, 1)),
      },
      {
        kind: 'pixels',
        x: 30,
        y: 40,
        w: 512,
        h: 512,
        mask: packBits(new Uint8Array(MAX_RASTER_BITS).fill(1)),
      },
    ] as const) {
      const document = documentOf(shape)
      const response = await h.call('PUT', id, { ...h.body, document })
      expect(response.status).toBe(200)
      const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
      expect(region).toMatchObject({
        document,
        rect: { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
      })
      expect(await h.sql.regions.readRegion(id)).toEqual(region)
      const list = await h.app.request('/v1/work/regions?season=0', {
        headers: { authorization: 'Bearer read' },
      })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({ regions: [region] })
    }
    expect(h.publishRegions).toHaveBeenCalledTimes(2)
  })

  it('rejects a raster document with a wrong-length mask', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, {
      ...h.body,
      document: documentOf({ kind: 'pixels', x: 10, y: 20, w: 8, h: 8, mask: 'gA==' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid region request' })
    expect(await h.sql.regions.readRegion(id)).toBeNull()
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('round-trips a star, subtraction, and stroked path with derived bounds', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, { ...h.body, document })
    expect(response.status).toBe(200)
    const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
    expect(region).toMatchObject({ document, rect: regionDocumentBounds(document) })
    expect(await h.sql.regions.readRegion(id)).toEqual(region)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
    if (database !== undefined) {
      expect(
        database.sqlite.prepare('SELECT shape, x, y, w, h FROM work_regions WHERE id = ?').get(id),
      ).toEqual({ shape: JSON.stringify(region.document), ...regionDocumentBounds(document) })
    }
  })

  it.each(['report', 'admin'])(
    'updates document and label in place as %s and broadcasts',
    async (token) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const original = Schema.decodeUnknownSync(RegionClaimSchema)(
        await (await h.call('PUT', id, h.body)).json(),
      )
      const publications: unknown[] = []
      h.publishRegions.mockImplementation(async () => {
        publications.push(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE))
      })
      const response = await h.call(
        'PUT',
        id,
        {
          ...h.body,
          actor: token === 'admin' ? other : { ...actor, displayName: 'New name' },
          document,
          label: 'Star work',
        },
        token,
      )
      expect(response.status).toBe(200)
      const updated = {
        ...original,
        document,
        rect: regionDocumentBounds(document),
        label: 'Star work',
      }
      expect(await response.json()).toEqual(updated)
      expect(await h.sql.regions.readRegion(id)).toEqual(updated)
      expect(publications).toEqual([[updated]])
      expect(h.publishRegions).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects an ellipse outside the surface and an out-of-range radius with 400', async () => {
    const h = await setup(adapter)
    const outside = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: documentOf({ kind: 'ellipse', x: WORLD_PIXELS - 1, y: 0, w: 8, h: 8 }),
    })
    expect(outside.status).toBe(400)
    expect(await outside.json()).toEqual({ error: 'Region is outside the drawing surface' })
    const invalid = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: documentOf({ ...star, r: 1_001 }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'Invalid region request' })
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('validates scope, identity, template membership, rect bounds and area, and label length', async () => {
    const h = await setup(adapter)
    expect((await h.call('PUT', uuidV7(), h.body, 'read')).status).toBe(403)
    for (const body of [
      { ...h.body, document: documentOf({ ...rectangle, x: WORLD_PIXELS }) },
      { ...h.body, document: documentOf({ ...rectangle, w: 2_001, h: 2_000 }) },
      { ...h.body, document: documentOf({ ...rectangle, x: -1 }) },
      { ...h.body, label: 'x'.repeat(65) },
      { ...h.body, actor: { ...actor, displayName: '' } },
      { ...h.body, templateId: 'bad' },
    ])
      expect((await h.call('PUT', uuidV7(), body)).status).toBe(400)
    expect((await h.call('PUT', uuidV7(), h.body, 'report', 'season=1')).status).toBe(400)
    expect(
      (
        await h.call(
          'PUT',
          uuidV7(),
          h.body,
          'report',
          'season=0&surface=alliance-picture&allianceId=1',
        )
      ).status,
    ).toBe(400)
    expect(
      (await h.call('PUT', uuidV7(), h.body, 'report', 'season=0&allianceId=bad')).status,
    ).toBe(400)
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('keeps conflicting concurrent IDs immutable and enforces the surface cap atomically', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const responses = await Promise.all(
      [actor, other].map((actor) => h.call('PUT', id, { ...h.body, actor })),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const region = await h.sql.regions.readRegion(id)
    if (region === null) throw new Error('Missing region')
    for (let i = 1; i < MAX_PRESENCE_REGIONS; i++)
      expect(await h.sql.regions.createRegion({ ...region, id: uuidV7(), createdAt: i })).toBe(true)
    expect(await h.sql.regions.createRegion({ ...region, id: uuidV7() })).toBe(false)
    const list = await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)
    expect(list).toHaveLength(MAX_PRESENCE_REGIONS)
    expect(list[0]?.createdAt).toBe(1)
    expect((await h.call('PUT', uuidV7(), h.body)).status).toBe(409)
    expect((await h.call('DELETE', id, { actor: region.claimant })).status).toBe(200)
    expect((await h.call('PUT', uuidV7(), h.body)).status).toBe(200)
  })

  it('rejects documents containing only subtractions without changing an existing claim', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const original = Schema.decodeUnknownSync(RegionClaimSchema)(
      await (await h.call('PUT', id, h.body)).json(),
    )
    for (const target of [id, uuidV7()]) {
      const response = await h.call('PUT', target, {
        ...h.body,
        document: { items: [{ id: 'cutout', shape: star, op: 'subtract' }] },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Region document must contain an added shape',
      })
    }
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([original])
    expect(h.publishRegions).toHaveBeenCalledTimes(1)
  })

  it('rejects a document whose added shapes span more than the region area limit', async () => {
    const h = await setup(adapter)
    const response = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: {
        items: [
          { id: 'first', shape: rectangle, op: 'add' },
          { id: 'second', shape: { ...rectangle, x: 2_000, y: 2_000 }, op: 'add' },
        ],
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Region area exceeds limit' })
    expect(h.publishRegions).not.toHaveBeenCalled()
  })
})

it.each([null, '{', 'null', JSON.stringify({ ...star, inner: star.r }), '{"items":[]}'])(
  'reads a legacy rectangle when stored shape is %s',
  async (shape) => {
    const h = await setup('d1')
    const id = uuidV7()
    const original = Schema.decodeUnknownSync(RegionClaimSchema)(
      await (await h.call('PUT', id, h.body)).json(),
    )
    database?.sqlite.prepare('UPDATE work_regions SET shape = ? WHERE id = ?').run(shape, id)
    const region = {
      ...original,
      document: { items: [{ id: 'legacy', shape: rectangle, op: 'add' }] },
    }
    expect(await h.sql.regions.readRegion(id)).toEqual(region)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
  },
)

it('wraps a legacy single-shape row in a document', async () => {
  const h = await setup('d1')
  const id = uuidV7()
  const original = Schema.decodeUnknownSync(RegionClaimSchema)(
    await (await h.call('PUT', id, { ...h.body, document: documentOf(star) })).json(),
  )
  database?.sqlite
    .prepare('UPDATE work_regions SET shape = ? WHERE id = ?')
    .run(JSON.stringify(star), id)
  const region = {
    ...original,
    document: { items: [{ id: 'legacy', shape: star, op: 'add' }] },
  }
  expect(await h.sql.regions.readRegion(id)).toEqual(region)
  expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
})
