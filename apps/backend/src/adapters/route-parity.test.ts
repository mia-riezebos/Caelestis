import { encodeIndexedPng, millis } from '@wts/shared'
import { Manifest } from '@wts/wire-schema'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { Ports } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from './memory/memory-blob-store.js'
import { MemoryCounterStore } from './memory/memory-counter-store.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const bearer = { authorization: `Bearer ${BOOTSTRAP}` }

const d1App = () => {
  const d1 = new SqliteD1Database()
  const sql = new D1SqlStore(d1 as unknown as D1Database)
  const ports: Ports = {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { d1, app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP, currentSeason: 1 }) }
}

const memApp = () => {
  const sql = new MemorySqlStore()
  const ports: Ports = {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(Date.now())),
  }
  return { app: createApp(ports, { bootstrapAdminToken: BOOTSTRAP, currentSeason: 1 }) }
}

const post = (app: ReturnType<typeof memApp>['app'], body: unknown) =>
  app.request('/admin/nodes', { method: 'POST', headers: bearer, body: JSON.stringify(body) })

const NAMES = [
  'Canada',
  'Québec',
  '  spaced  ',
  'a.b.c',
  'a_b',
  'a%b',
  'a/b',
  '...dots...',
  '--- ---',
  'ß',
  'İstanbul',
  'हिंदी',
  'café́',
  'x'.repeat(256),
  '1',
  '.',
  'a\u0000b',
  'emoji 🎨 art',
  'ＦＵＬＬＷＩＤＴＨ',
  'Ⅻ',
  '٣',
  'a  b',
  '𝐀𝐁',
  'tab\there',
  'new\nline',
]

/**
 * The same requests against both adapters, asserting they answer the same thing.
 *
 * Seven separate defects in this stack have come from `MemorySqlStore` and `D1SqlStore` disagreeing,
 * and the reason each one survived review is structural: every route test runs against the memory
 * store, so anything D1 enforces and the oracle does not is invisible no matter how carefully the
 * routes are tested. Per-method tests kept missing it because the divergence was never in a method's
 * contract — it was in what the database does underneath one of them.
 *
 * So this compares outcomes rather than implementations, through the routes, on inputs chosen to
 * poke at where the two differ: case folding, Unicode, LIKE metacharacters, path derivation, and
 * error translation. The `.not.toBe(500)` assertions are the point — a 500 is how every one of those
 * seven defects actually surfaced.
 *
 * The D1 flow at the end goes further and ends in a decode, because parity alone would be satisfied
 * by both adapters being wrong together.
 */
describe('route parity between adapters', () => {
  it.each(NAMES)('answers the same status for node name %j', async (name) => {
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const a = await post(app, { season: 1, parentId: null, name })
    const b = await post(memory, { season: 1, parentId: null, name })
    const aBody = (await a.json()) as { path?: string }
    const bBody = (await b.json()) as { path?: string }
    d1.close()
    expect({ status: a.status, path: aBody.path }).toEqual({ status: b.status, path: bBody.path })
    expect(a.status).not.toBe(500)
  })

  it('answers the same for a path already taken, and for one taken in another season', async () => {
    // Every name case above starts from an empty store, so no conflict is ever produced through a
    // route on the D1 side — the 400 existed only in per-adapter tests, and the two stores decide it
    // by different means: a `lower()` expression index in SQLite, `foldPath` in JavaScript.
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const answers = async (target: ReturnType<typeof memApp>['app']) => {
      await post(target, { season: 1, parentId: null, name: 'Canada' })
      return {
        same: (await post(target, { season: 1, parentId: null, name: 'Canada' })).status,
        folded: (await post(target, { season: 1, parentId: null, name: 'CANADA' })).status,
        otherSeason: (await post(target, { season: 2, parentId: null, name: 'Canada' })).status,
      }
    }
    const fromD1 = await answers(app)
    d1.close()

    expect(fromD1).toEqual(await answers(memory))
    expect(fromD1).toEqual({ same: 400, folded: 400, otherSeason: 201 })
  })

  it('lists a season the same way through both adapters', async () => {
    // The two order by different rules — `localeCompare` in memory, BINARY `ORDER BY id` in SQLite —
    // and the listing is served straight to the caller rather than re-sorted by the assembler, so
    // this is the one manifest-adjacent ordering nothing else compares.
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const listed = async (target: ReturnType<typeof memApp>['app']) => {
      for (const name of ['Zulu', 'alpha', 'Bravo', 'Ångström', 'zebra']) {
        await post(target, { season: 1, parentId: null, name })
      }
      const response = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await response.json()) as ReadonlyArray<Record<string, unknown>>
      return {
        status: response.status,
        paths: body.map((entry) => entry.path),
        keys: Object.keys(body[0] ?? {}).sort(),
      }
    }
    const fromD1 = await listed(app)
    d1.close()

    expect(fromD1).toEqual(await listed(memory))
    // `season` is a server-side scoping key, not part of what a node is to a caller.
    expect(fromD1.keys).not.toContain('season')
  })

  it('moves a subtree the same way through both adapters', async () => {
    // The rename tests lived in the memory-only harness, so D1's subtree rewrite — a `substr` over a
    // materialized prefix, which is the whole difficulty of this feature — was never executed by
    // anything. It wrote `/renamedchild` for every descendant of every rename, in production only.
    //
    // The grandchild proves the rewrite is not just one level deep, and `/parentx` proves the prefix
    // match stops at a path boundary rather than dragging in a sibling that merely starts the same.
    const tree = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'Parent' })
      const parentId = ((await parent.json()) as { id: string }).id
      const child = await post(target, { season: 1, parentId, name: 'Child' })
      const childId = ((await child.json()) as { id: string }).id
      await post(target, { season: 1, parentId: childId, name: 'Grand' })
      await post(target, { season: 1, parentId: null, name: 'Parentx' })

      const renamed = await target.request(`/admin/nodes/${parentId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'Renamed' }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return { status: renamed.status, paths: body.map((entry) => entry.path).sort() }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await tree(app)
    d1.close()

    expect(fromD1).toEqual(await tree(memory))
    expect(fromD1).toEqual({
      status: 200,
      paths: ['/parentx', '/renamed', '/renamed/child', '/renamed/child/grand'],
    })
  })

  it('renames a nested node and keeps its parent prefix', async () => {
    // Every successful D1-backed rename above targets a root, and the only child rename exits at the
    // length guard before any SQL runs. So breaking the parent prefix — writing a child as
    // `/renamed` rather than `/parent/renamed` — was invisible to the whole suite.
    const nested = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'Parent' })
      const parentId = ((await parent.json()) as { id: string }).id
      const child = await post(target, { season: 1, parentId, name: 'Child' })
      const childId = ((await child.json()) as { id: string }).id
      await post(target, { season: 1, parentId: childId, name: 'Grand' })

      const renamed = await target.request(`/admin/nodes/${childId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'Moved' }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string; name: string }>
      // Ids and timestamps differ between the two runs by construction; everything else must not.
      const { name, path } = (await renamed.json()) as { name: string; path: string }
      return {
        renamed: { name, path },
        paths: body.map((entry) => entry.path).sort(),
        names: body.map((entry) => entry.name).sort(),
      }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await nested(app)
    d1.close()

    expect(fromD1).toEqual(await nested(memory))
    // The name is asserted too: nothing else compared it across adapters, so dropping `name` from
    // D1's root update left PATCH not performing its primary operation, green.
    expect(fromD1.renamed).toMatchObject({ name: 'Moved', path: '/parent/moved' })
    expect(fromD1.paths).toEqual(['/parent', '/parent/moved', '/parent/moved/grand'])
    expect(fromD1.names).toEqual(['Grand', 'Moved', 'Parent'])
  })

  it('rolls the subtree back when the rename itself collides', async () => {
    // The descendant update runs first, so without one transaction it commits and the root update
    // then hits the unique index — leaving children under a prefix their parent never took. The
    // existing collision case renames a childless node, so sequential updates would pass it.
    const rollback = async (target: ReturnType<typeof memApp>['app']) => {
      await post(target, { season: 1, parentId: null, name: 'Taken' })
      const other = await post(target, { season: 1, parentId: null, name: 'Other' })
      const otherId = ((await other.json()) as { id: string }).id
      await post(target, { season: 1, parentId: otherId, name: 'Child' })

      const renamed = await target.request(`/admin/nodes/${otherId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'Taken' }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return { status: renamed.status, paths: body.map((entry) => entry.path).sort() }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await rollback(app)
    d1.close()

    expect(fromD1).toEqual(await rollback(memory))
    expect(fromD1).toEqual({ status: 409, paths: ['/other', '/other/child', '/taken'] })
  })

  it('renames a node whose path is longer than a LIKE pattern may be', async () => {
    // D1 caps a LIKE or GLOB pattern at 50 bytes. The subtree match was a LIKE over the node's path,
    // which may be 256 characters, so every rename of anything but a shallow group answered "LIKE or
    // GLOB pattern too complex" — a 500 for the ordinary case, invisible here until the D1 fake was
    // taught the same limit.
    const deep = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'g'.repeat(60) })
      const parentId = ((await parent.json()) as { id: string }).id
      await post(target, { season: 1, parentId, name: 'Child' })

      const renamed = await target.request(`/admin/nodes/${parentId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'h'.repeat(60) }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return { status: renamed.status, paths: body.map((entry) => entry.path).sort() }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await deep(app)
    d1.close()

    expect(fromD1).toEqual(await deep(memory))
    expect(fromD1).toEqual({
      status: 200,
      paths: [`/${'h'.repeat(60)}`, `/${'h'.repeat(60)}/child`],
    })
  })

  it('accepts a rename that lands exactly on the bound', async () => {
    // Every other length case is one past it, so a `>=` would reject a legal path and no test would
    // notice. `/` plus 255 is exactly 256.
    const exact = async (target: ReturnType<typeof memApp>['app']) => {
      const created = await post(target, { season: 1, parentId: null, name: 'n' })
      const id = ((await created.json()) as { id: string }).id
      const renamed = await target.request(`/admin/nodes/${id}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'e'.repeat(255) }),
      })
      const body = (await renamed.json()) as { path?: string }
      return { status: renamed.status, length: body.path?.length }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await exact(app)
    d1.close()

    expect(fromD1).toEqual(await exact(memory))
    expect(fromD1).toEqual({ status: 200, length: 256 })
  })

  it('leaves another season alone when a rename moves a subtree', async () => {
    // The descendant match is scoped by season as well as by prefix, and the same path legally
    // exists in two seasons. Without the season clause a rename reaches into the other one and
    // rewrites paths whose parents never moved — silently, since nothing about the request mentions
    // that season.
    const across = async (target: ReturnType<typeof memApp>['app']) => {
      const ids: Record<number, string> = {}
      for (const season of [1, 2]) {
        const parent = await post(target, { season, parentId: null, name: 'Canada' })
        const parentId = ((await parent.json()) as { id: string }).id
        ids[season] = parentId
        await post(target, { season, parentId, name: 'Child' })
      }

      await target.request(`/admin/nodes/${ids[1]}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'Renamed' }),
      })
      const listed = await target.request('/admin/nodes?season=2', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return body.map((entry) => entry.path).sort()
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await across(app)
    d1.close()

    expect(fromD1).toEqual(await across(memory))
    expect(fromD1).toEqual(['/canada', '/canada/child'])
  })

  it('bounds the renamed path itself, not only what hangs beneath it', async () => {
    // The over-long case above always has a descendant, so only the shifted-descendant term was
    // exercised. A childless node renamed under a deep parent tests the node's own path.
    const childless = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'p'.repeat(200) })
      const parentId = ((await parent.json()) as { id: string }).id
      const leaf = await post(target, { season: 1, parentId, name: 'leaf' })
      const leafId = ((await leaf.json()) as { id: string }).id

      const renamed = await target.request(`/admin/nodes/${leafId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'q'.repeat(100) }),
      })
      return renamed.status
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await childless(app)
    d1.close()

    expect(fromD1).toBe(await childless(memory))
    expect(fromD1).toBe(400)
  })

  it("counts a rename against the wire's units, not the database's", async () => {
    // The bound was derived by mixing SQLite's character count with JavaScript's UTF-16 count, so an
    // astral descendant slipped past it: the CHECK saw 138 characters and passed, the wire saw 264
    // units and refused, and `/manifest` stopped decoding for every client with nothing raised
    // server-side. The memory store refused the same request, so the route suite could not see it.
    const astral = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'a' })
      const parentId = ((await parent.json()) as { id: string }).id
      await post(target, { season: 1, parentId, name: '𝐀'.repeat(126) })

      const renamed = await target.request(`/admin/nodes/${parentId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'b'.repeat(10) }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return { status: renamed.status, longest: Math.max(...body.map((e) => e.path.length)) }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await astral(app)
    d1.close()

    expect(fromD1).toEqual(await astral(memory))
    expect(fromD1.status).toBe(400)
    expect(fromD1.longest).toBeLessThanOrEqual(256)
  })

  it('answers an overflowing collision the same way on both sides', async () => {
    // A rename can both collide and overflow. D1 cannot ask its unique index anything until the
    // write, so length is what it checks first; the memory store checked collision first and
    // answered 409 where production answered 400.
    const both = async (target: ReturnType<typeof memApp>['app']) => {
      await post(target, { season: 1, parentId: null, name: 'b'.repeat(100) })
      const parent = await post(target, { season: 1, parentId: null, name: 'a' })
      const parentId = ((await parent.json()) as { id: string }).id
      await post(target, { season: 1, parentId, name: 'x'.repeat(200) })

      const renamed = await target.request(`/admin/nodes/${parentId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'b'.repeat(100) }),
      })
      return renamed.status
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await both(app)
    d1.close()

    expect(fromD1).toBe(await both(memory))
    expect(fromD1).toBe(400)
  })

  it('refuses the same colliding rename through both adapters', async () => {
    // The conflict a rename hits is D1's unique index, not a check the code performs, so the 409
    // depends entirely on translating that constraint — and the only collision test ran against the
    // memory store, which reaches its answer a different way. Deleting D1's translation left the
    // whole suite green while production answered 500 to an ordinary duplicate name.
    const collide = async (target: ReturnType<typeof memApp>['app']) => {
      await post(target, { season: 1, parentId: null, name: 'Taken' })
      const other = await post(target, { season: 1, parentId: null, name: 'Other' })
      const otherId = ((await other.json()) as { id: string }).id

      const renamed = await target.request(`/admin/nodes/${otherId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'TAKEN' }),
      })
      return { status: renamed.status, body: await renamed.json() }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await collide(app)
    d1.close()

    // Case-folded, because the index is on `lower(path)` — `/TAKEN` and `/taken` are one path.
    expect(fromD1).toEqual(await collide(memory))
    expect(fromD1.status).toBe(409)
  })

  it('refuses the same over-long rename through both adapters', async () => {
    // A rename lengthens every path beneath it, so the request that breaks the 256-character bound
    // is one whose own path is well inside it. D1 has a CHECK and the memory store had nothing, so
    // this was a 500 on one side and a 200 carrying a wire-invalid path on the other.
    const overflow = async (target: ReturnType<typeof memApp>['app']) => {
      const parent = await post(target, { season: 1, parentId: null, name: 'a' })
      const parentId = ((await parent.json()) as { id: string }).id
      await post(target, { season: 1, parentId, name: 'x'.repeat(200) })

      const renamed = await target.request(`/admin/nodes/${parentId}`, {
        method: 'PATCH',
        headers: bearer,
        body: JSON.stringify({ name: 'b'.repeat(100) }),
      })
      const listed = await target.request('/admin/nodes?season=1', { headers: bearer })
      const body = (await listed.json()) as ReadonlyArray<{ path: string }>
      return { status: renamed.status, longest: Math.max(...body.map((e) => e.path.length)) }
    }
    const { d1, app } = d1App()
    const { app: memory } = memApp()
    const fromD1 = await overflow(app)
    d1.close()

    expect(fromD1).toEqual(await overflow(memory))
    // Refused, and nothing moved.
    expect(fromD1).toEqual({ status: 400, longest: 203 })
  })

  it('answers the same for deep nesting and long paths', async () => {
    const { d1, app } = d1App()
    let parentId: string | null = null
    const statuses: number[] = []
    for (let index = 0; index < 40; index += 1) {
      const response = await post(app, { season: 1, parentId, name: `group${index}` })
      statuses.push(response.status)
      const body = (await response.json()) as { id?: string }
      if (body.id !== undefined) parentId = body.id
    }
    d1.close()
    expect(statuses.every((status) => status === 201 || status === 400)).toBe(true)
    expect(statuses).not.toContain(500)
  })

  it('runs the full admin flow on D1 and emits a decodable manifest', async () => {
    const { d1, app } = d1App()
    const created = await post(app, { season: 1, parentId: null, name: 'Group' })
    expect(created.status).toBe(201)
    const nodeId = ((await created.json()) as { id: string }).id

    const png = await encodeIndexedPng(2, 1, new Uint8Array([1, 2]))
    const form = new FormData()
    form.set('png', new File([png.slice()], 't.png', { type: 'image/png' }))
    form.set('nodeId', nodeId)
    form.set('name', 'Mural')
    form.set('originX', '0')
    form.set('originY', '0')
    const upload = await app.request('/admin/templates', {
      method: 'POST',
      body: form,
      headers: bearer,
    })
    expect(upload.status).toBe(201)
    const templateId = ((await upload.json()) as { templateId: string }).templateId

    // Members see nothing until it is published.
    const draft = await app.request('/manifest', { headers: bearer })
    expect(draft.status).toBe(200)
    const draftDocument: unknown = await draft.json()
    expect(() => Schema.decodeUnknownSync(Manifest)(draftDocument)).not.toThrow()

    const patched = await app.request(`/admin/templates/${templateId}`, {
      method: 'PATCH',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
    expect(patched.status).toBe(200)

    const manifest = await app.request('/manifest', { headers: bearer })
    const document: unknown = await manifest.json()
    expect(() => Schema.decodeUnknownSync(Manifest)(document)).not.toThrow()

    // Deleting an occupied node is a 409, not a 500.
    const deleted = await app.request(`/admin/nodes/${nodeId}`, {
      method: 'DELETE',
      headers: bearer,
    })
    expect(deleted.status).toBe(409)

    // Unpublish round-trips.
    const unpublished = await app.request(`/admin/templates/${templateId}`, {
      method: 'PATCH',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ published: false }),
    })
    expect(unpublished.status).toBe(200)

    // A template that does not exist is a 404.
    const missing = await app.request('/admin/templates/01890f3a-6b7c-7def-8123-456789abcdef', {
      method: 'PATCH',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
    expect(missing.status).toBe(404)
    d1.close()
  })

  it('emits a decodable manifest for a node whose name is unicode', async () => {
    const { d1, app } = d1App()
    for (const name of ['Québec', 'हिंदी', 'ＦＵＬＬ', 'a.b', 'x-y']) {
      const response = await post(app, { season: 1, parentId: null, name })
      expect(response.status).toBe(201)
    }
    const manifest = await app.request('/manifest', { headers: bearer })
    const document: unknown = await manifest.json()
    d1.close()
    expect(() => Schema.decodeUnknownSync(Manifest)(document)).not.toThrow()
  })
})
