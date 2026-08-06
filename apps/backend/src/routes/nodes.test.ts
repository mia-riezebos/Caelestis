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
  it('renames a node and carries its descendants along', async () => {
    // `path` is a materialized prefix, so a rename is not a one-row update: every descendant holds
    // the old path as a prefix. Leaving them behind breaks every rollup silently rather than loudly.
    const { sql, app } = harness()
    const parent = await createNode(app, { season: 0, parentId: null, name: 'Parent' })
    const child = await createNode(app, { season: 0, parentId: parent.body.id, name: 'Child' })
    expect(child.body.path).toBe('/parent/child')

    const response = await app.request(`/admin/nodes/${parent.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ name: 'Renamed' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ name: 'Renamed', path: '/renamed' })
    await expect(sql.readNode(child.body.id)).resolves.toMatchObject({ path: '/renamed/child' })
  })

  it('refuses a rename that would collide with a sibling', async () => {
    const { app } = harness()
    await createNode(app, { season: 0, parentId: null, name: 'Taken' })
    const other = await createNode(app, { season: 0, parentId: null, name: 'Other' })

    const response = await app.request(`/admin/nodes/${other.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ name: 'Taken' }),
    })

    expect(response.status).toBe(409)
  })

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
      createdBy: 'bootstrap',
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
