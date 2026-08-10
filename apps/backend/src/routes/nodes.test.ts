import { millis } from '@caelestis/shared'
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
  const blobs = new MemoryBlobStore()
  const ports: Ports = {
    blobs,
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { blobs, sql, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP }) }
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
      const patched = await app.request('/admin/nodes/whatever', {
        method: 'PATCH',
        headers: holder,
        body: JSON.stringify({ name: 'Sneaky' }),
      })
      const deleted = await app.request('/admin/nodes/whatever', {
        method: 'DELETE',
        headers: holder,
      })

      expect([created.status, listed.status, patched.status, deleted.status]).toEqual([
        403, 403, 403, 403,
      ])
    },
  )

  it('renames and re-parents in one patch and exposes the new structure in the manifest', async () => {
    const { app } = harness()
    const destination = await createNode(app, {
      season: 1,
      parentId: null,
      name: 'Destination',
    })
    const source = await createNode(app, { season: 1, parentId: null, name: 'Source' })

    const response = await app.request(`/admin/nodes/${source.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ name: 'Renamed', parentId: destination.body.id }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: source.body.id,
      name: 'Renamed',
      parentId: destination.body.id,
      path: '/destination/renamed',
    })
    const manifest = (await (await app.request('/manifest', { headers: bearer })).json()) as {
      nodes: NodeResponse[]
    }
    expect(manifest.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: source.body.id,
          name: 'Renamed',
          parentId: destination.body.id,
          path: '/destination/renamed',
        }),
      ]),
    )
  })

  it('rejects a patch that changes neither the name nor the parent', async () => {
    const { app } = harness()
    const source = await createNode(app, { season: 1, parentId: null, name: 'Source' })

    const response = await app.request(`/admin/nodes/${source.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'patch must set at least one of name, parentId',
    })
  })

  it('renames a node and carries its descendants along', async () => {
    // `path` is a materialized prefix, so a rename is not a one-row update: every descendant holds
    // the old path as a prefix. Leaving them behind breaks every rollup silently rather than loudly.
    const { sql, app } = harness()
    const parent = await createNode(app, { season: 1, parentId: null, name: 'Parent' })
    const child = await createNode(app, { season: 1, parentId: parent.body.id, name: 'Child' })
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

  it.each([
    ['a malformed id', 'not-a-uuid', { name: 'Fine' }, 400],
    ['an unknown id', '01890f3a-6b7c-7def-8123-4560000000ff', { name: 'Fine' }, 404],
    ['a missing name', '01890f3a-6b7c-7def-8123-4560000000ff', {}, 400],
    ['a name of the wrong type', '01890f3a-6b7c-7def-8123-4560000000ff', { name: 7 }, 400],
    ['an empty name', '01890f3a-6b7c-7def-8123-4560000000ff', { name: '' }, 400],
    ['an over-long name', '01890f3a-6b7c-7def-8123-4560000000ff', { name: 'x'.repeat(257) }, 400],
    [
      'a name with no letter or number',
      '01890f3a-6b7c-7def-8123-4560000000ff',
      { name: '---' },
      400,
    ],
  ] as const)('refuses a rename with %s', async (_label, id, body, status) => {
    // Each guard on PATCH was deletable: the id check, the body parse, the three name checks and the
    // sluggability check all had the surface to themselves, and the one success test walked past all
    // of them. Ordered so the id and body checks answer before anything reads the store.
    const { app } = harness()

    const response = await app.request(`/admin/nodes/${id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(status)
  })

  it('refuses a rename whose body is not JSON at all', async () => {
    const { app } = harness()
    const response = await app.request('/admin/nodes/01890f3a-6b7c-7def-8123-4560000000ff', {
      method: 'PATCH',
      headers: bearer,
      body: 'not json',
    })

    expect(response.status).toBe(400)
  })

  it('returns the whole renamed node, not just what changed', async () => {
    // The route used to answer with a record it assembled itself. It now returns what the store
    // wrote, which is the only version that reflects the path the store actually composed.
    const { app } = harness()
    const created = await createNode(app, {
      season: 1,
      parentId: null,
      name: 'Before',
      description: 'Kept',
    })

    const response = await app.request(`/admin/nodes/${created.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ name: 'After' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: created.body.id,
      parentId: null,
      path: '/after',
      name: 'After',
      description: 'Kept',
      createdAt: created.body.createdAt,
    })
  })

  it('accepts a rename to the name the node already has', async () => {
    // What a rename dialog sends when it is confirmed without an edit. The node's own row is in the
    // table it checks for collisions, so without excluding itself this is a 409 against itself.
    const { app } = harness()
    const created = await createNode(app, { season: 1, parentId: null, name: 'Same' })

    const response = await app.request(`/admin/nodes/${created.body.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ name: 'Same' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ path: '/same' })
  })

  it('refuses a rename that would collide with a sibling', async () => {
    const { app } = harness()
    await createNode(app, { season: 1, parentId: null, name: 'Taken' })
    const other = await createNode(app, { season: 1, parentId: null, name: 'Other' })

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

  it('refuses a name or description one character past what the wire will carry', async () => {
    // Neither bound is a SQL constraint, so deleting either route guard left the suite green — and
    // an over-long name is not a rejected request, it is a season whose manifest every client
    // refuses to decode, permanently, for one group nobody can see is at fault.
    //
    // At the root the binding bound is the path, not the name: the path is `/` + the slug, so a
    // 256-character name derives a 257-character path and the shorter limit is what answers.
    const { app } = harness()
    const create = async (body: Parameters<typeof createNode>[1]) =>
      (await createNode(app, body)).response.status

    expect(await create({ season: 1, parentId: null, name: 'x'.repeat(255) })).toBe(201)
    expect(await create({ season: 1, parentId: null, name: 'y'.repeat(256) })).toBe(400)
    expect(await create({ season: 1, parentId: null, name: 'z'.repeat(257) })).toBe(400)
    expect(
      await create({ season: 1, parentId: null, name: 'Ok', description: 'd'.repeat(4_096) }),
    ).toBe(201)
    expect(
      await create({ season: 1, parentId: null, name: 'Ok2', description: 'd'.repeat(4_097) }),
    ).toBe(400)
  })

  it('refuses season zero, which no deployment can be configured to serve', async () => {
    // The wire and the routes used to accept season 0 while `worker.ts` refused `SEASON=0`, so an
    // admin could build a whole tree in a season the server could never make its default — visible
    // only to a client that already knew to ask for it by number.
    const { app } = harness()

    expect(
      (await createNode(app, { season: 0, parentId: null, name: 'Ghost' })).response.status,
    ).toBe(400)
    expect((await app.request('/admin/nodes?season=0', { headers: bearer })).status).toBe(400)
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

  it('counts and cascades a subtree while retaining a shared chunk blob', async () => {
    const { app, blobs, sql } = harness()
    const root = await createNode(app, { season: 1, parentId: null, name: 'Root' })
    const child = await createNode(app, { season: 1, parentId: root.body.id, name: 'Child' })
    const grandchild = await createNode(app, {
      season: 1,
      parentId: child.body.id,
      name: 'Grandchild',
    })
    const outside = await createNode(app, { season: 1, parentId: null, name: 'Outside' })
    const shared = 'a'.repeat(64)
    const orphaned = 'b'.repeat(64)
    const makeVersion = (
      templateId: string,
      nodeId: string,
      versionId: string,
      hashes: readonly string[],
    ): TemplateVersionRecord => ({
      templateId,
      nodeId,
      name: templateId,
      versionId,
      createdBy: 'bootstrap',
      createdAt: millis(1_750_000_000_000),
      bbox: { minX: 0, minY: 0, maxX: hashes.length, maxY: 1 },
      totalPixels: hashes.length,
      chunks: hashes.map((hash, tileX) => ({ tileX, tileY: 0, hash })),
    })
    await sql.insertTemplateVersion(
      makeVersion('01890f3a-6b7c-7def-8123-456789abcda0', root.body.id, 'root-version', [shared]),
    )
    await sql.insertTemplateVersion(
      makeVersion('01890f3a-6b7c-7def-8123-456789abcda1', grandchild.body.id, 'deep-version', [
        orphaned,
      ]),
    )
    await sql.insertTemplateVersion(
      makeVersion('01890f3a-6b7c-7def-8123-456789abcda2', outside.body.id, 'outside-version', [
        shared,
      ]),
    )
    await blobs.put('chunks', shared, new Uint8Array([1, 2, 3]))
    await blobs.put('chunks', orphaned, new Uint8Array([4, 5, 6]))

    const count = await app.request(`/admin/nodes/${root.body.id}/subtree`, { headers: bearer })
    expect(count.status).toBe(200)
    await expect(count.json()).resolves.toEqual({ nodes: 3, templates: 2 })

    const deleted = await app.request(`/admin/nodes/${root.body.id}?cascade=true`, {
      method: 'DELETE',
      headers: bearer,
    })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toEqual({ nodes: 3, templates: 2, chunks: 1 })

    const sharedChunk = await app.request(`/chunks/${shared}`, { headers: bearer })
    expect(sharedChunk.status).toBe(200)
    await expect(sharedChunk.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)
    expect((await app.request(`/chunks/${orphaned}`, { headers: bearer })).status).toBe(404)
    await expect(sql.readTemplate('01890f3a-6b7c-7def-8123-456789abcda2')).resolves.not.toBeNull()
  })

  it('returns 404 when counting a missing subtree', async () => {
    const { app } = harness()
    const response = await app.request(
      '/admin/nodes/01890f3a-6b7c-7def-8123-456789abcde9/subtree',
      { headers: bearer },
    )
    expect(response.status).toBe(404)
  })
})
