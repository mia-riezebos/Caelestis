import { millis } from '@wts/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { Ports, TemplateVersionRecord } from '../ports/index.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const bearer = { authorization: `Bearer ${BOOTSTRAP}` }

const harness = () => {
  const sql = new MemorySqlStore()
  const ports: Ports = {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { sql, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP }) }
}

type NodeResponse = {
  id: string
  parentId: string | null
  path: string
  name: string
  description?: string
  createdAt: number
}

const createNode = async (
  app: ReturnType<typeof harness>['app'],
  body: { season: number; parentId: string | null; name: string; description?: string },
) => {
  const response = await app.request('/admin/nodes', {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify(body),
  })
  return { response, body: (await response.json()) as NodeResponse }
}

describe('node routes', () => {
  it.each([['read'], ['report']])(
    'refuses a %s holder every method of the node surface',
    async (scope) => {
      // Every other test here authenticates as the bootstrap admin, which satisfies any scope — so
      // downgrading this surface's gate from `admin` to `read` left all 301 tests green while
      // letting an ordinary member create groups, enumerate any season's tree, and delete them.
      const { app } = harness()
      const minted = await app.request('/admin/tokens', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ label: scope, scope }),
      })
      const token = ((await minted.json()) as { token: string }).token
      const holder = { authorization: `Bearer ${token}` }

      const created = await app.request('/admin/nodes', {
        method: 'POST',
        headers: holder,
        body: JSON.stringify({ season: 1, parentId: null, name: 'Sneaky' }),
      })
      const listed = await app.request('/admin/nodes?season=1', { headers: holder })
      const deleted = await app.request('/admin/nodes/whatever', {
        method: 'DELETE',
        headers: holder,
      })

      expect([created.status, listed.status, deleted.status]).toEqual([403, 403, 403])
    },
  )

  it('round-trips a root and child with server-derived paths', async () => {
    const { app } = harness()
    const root = await createNode(app, {
      season: 1,
      parentId: null,
      name: 'Québec / North',
      description: 'Root',
    })
    expect(root.response.status).toBe(201)
    expect(root.body).toMatchObject({ path: '/québec-north', parentId: null, description: 'Root' })

    const child = await createNode(app, {
      season: 1,
      parentId: root.body.id,
      name: 'Montréal',
    })
    expect(child.response.status).toBe(201)
    expect(child.body).toMatchObject({ path: '/québec-north/montréal', parentId: root.body.id })

    const listed = await app.request('/admin/nodes?season=1', { headers: bearer })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: root.body.id }),
        expect.objectContaining({ id: child.body.id }),
      ]),
    )
  })

  it('rejects duplicate paths case-insensitively within a season but accepts them across seasons', async () => {
    const { app } = harness()
    expect(
      (await createNode(app, { season: 1, parentId: null, name: 'Canada' })).response.status,
    ).toBe(201)
    expect(
      (await createNode(app, { season: 1, parentId: null, name: 'CANADA' })).response.status,
    ).toBe(400)
    expect(
      (await createNode(app, { season: 2, parentId: null, name: 'Canada' })).response.status,
    ).toBe(201)
  })

  it('rejects missing and cross-season parents', async () => {
    const { app } = harness()
    const missing = await createNode(app, {
      season: 1,
      parentId: '01890f3a-6b7c-7def-8123-456789abcde9',
      name: 'Child',
    })
    expect(missing.response.status).toBe(400)
    expect(missing.body).toMatchObject({})

    const parent = await createNode(app, { season: 1, parentId: null, name: 'Parent' })
    const crossSeason = await createNode(app, {
      season: 2,
      parentId: parent.body.id,
      name: 'Child',
    })
    expect(crossSeason.response.status).toBe(400)
  })

  it('deletes an empty leaf and refuses a node with a template', async () => {
    const { app, sql } = harness()
    const occupied = await createNode(app, { season: 1, parentId: null, name: 'Occupied' })
    const version: TemplateVersionRecord = {
      templateId: '01890f3a-6b7c-7def-8123-456789abcda0',
      nodeId: occupied.body.id,
      name: 'Template',
      versionId: '01890f3a-6b7c-7def-8123-456789abcda1',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(1_750_000_000_000),
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'a'.repeat(64) }],
    }
    await sql.insertTemplateVersion(version)
    expect(
      (await app.request(`/admin/nodes/${occupied.body.id}`, { method: 'DELETE', headers: bearer }))
        .status,
    ).toBe(409)

    const leaf = await createNode(app, { season: 1, parentId: null, name: 'Leaf' })
    expect(
      (await app.request(`/admin/nodes/${leaf.body.id}`, { method: 'DELETE', headers: bearer }))
        .status,
    ).toBe(204)
    await expect(sql.readNode(leaf.body.id)).resolves.toBeNull()
  })
})
