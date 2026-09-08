import { millis, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { SqlStore } from '../ports/index.js'
import { TagConflictError } from './store.js'

const scope = { season: 1, surface: WORLD_TEMPLATE_SURFACE }
const seed = async (sql: SqlStore, id: string, published = true) => {
  await sql.insertTemplateVersion({
    ...scope,
    templateId: id,
    versionId: `version-${id}`,
    nodeId: null,
    name: id,
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    createdAt: millis(1000),
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
  })
  if (published) await sql.setTemplatePublishedAt(id, millis(1001), millis(1001))
}

describe.each(['memory', 'D1'])('%s tag storage', (adapter) => {
  let database: SqliteD1Database | undefined
  afterEach(() => database?.close())
  const make = (): SqlStore => {
    if (adapter === 'memory') return new MemorySqlStore()
    database = new SqliteD1Database()
    return new D1SqlStore(database as unknown as D1Database)
  }

  it('persists direct folder tags, scopes empty folders, and cascades deletion', async () => {
    let sql = make()
    for (const [id, season] of [
      ['folder', 1],
      ['other', 2],
    ] as const)
      await sql.insertNode({
        id,
        season,
        surface: scope.surface,
        parentId: null,
        path: id,
        name: id,
        description: null,
        createdAt: millis(1000),
      })
    await seed(sql, 'template')
    await sql.mutateTag({ type: 'create', id: 'tag', name: 'Repair' }, millis(2000))
    for (const folderId of ['folder', 'other'])
      expect(
        await sql.mutateTag(
          { type: 'assign-folder', id: 'tag', folderId, attached: true },
          millis(2001),
        ),
      ).toBe(true)
    await sql.mutateTag(
      { type: 'assign', id: 'tag', templateId: 'template', attached: true },
      millis(2001),
    )
    await sql.mutateTag({ type: 'rename', id: 'tag', name: 'Priority' }, millis(3000))
    if (database !== undefined) sql = new D1SqlStore(database as unknown as D1Database)
    expect(await sql.listNodeTagIds('folder')).toEqual(['tag'])
    expect(await sql.listManifestNodeTags(scope)).toEqual([
      { nodeId: 'folder', tag: { id: 'tag', name: 'Priority' } },
    ])
    expect(await sql.listTagScopes()).toContainEqual({ ...scope, season: 2 })
    await sql.mutateTag(
      { type: 'assign-folder', id: 'tag', folderId: 'folder', attached: false },
      millis(4000),
    )
    expect(await sql.listNodeTagIds('folder')).toEqual([])
    expect(
      await sql.mutateTag(
        { type: 'assign-folder', id: 'tag', folderId: 'missing', attached: true },
        millis(4000),
      ),
    ).toBe(false)
    await sql.deleteNode('other')
    expect(await sql.listNodeTagIds('other')).toEqual([])
    await sql.mutateTag(
      { type: 'assign-folder', id: 'tag', folderId: 'folder', attached: true },
      millis(4001),
    )
    await sql.mutateTag({ type: 'delete', id: 'tag' }, millis(5000))
    expect(await sql.listNodeTagIds('folder')).toEqual([])
    expect(await sql.readNode('folder')).not.toBeNull()
    expect(await sql.readTemplate('template')).not.toBeNull()
  })

  it('renames every assignment, survives reopening, and deletes labels without deleting templates', async () => {
    let sql = make()
    await seed(sql, 'first')
    await seed(sql, 'second')
    await sql.mutateTag({ type: 'create', id: 'tag', name: 'Repair' }, millis(2000))
    for (const templateId of ['first', 'second']) {
      expect(
        await sql.mutateTag(
          { type: 'assign', id: 'tag', templateId, attached: true },
          millis(2001),
        ),
      ).toBe(true)
    }
    await sql.mutateTag({ type: 'rename', id: 'tag', name: 'Priority' }, millis(3000))
    if (database !== undefined) sql = new D1SqlStore(database as unknown as D1Database)
    expect(await sql.listTemplateTagIds('first')).toEqual(['tag'])
    expect(await sql.listTemplateTagIds('missing')).toEqual([])
    expect(await sql.listManifestTags(scope, false)).toEqual([
      { templateId: 'first', tag: { id: 'tag', name: 'Priority' } },
      { templateId: 'second', tag: { id: 'tag', name: 'Priority' } },
    ])
    await sql.mutateTag(
      { type: 'assign', id: 'tag', templateId: 'first', attached: false },
      millis(3500),
    )
    expect(await sql.listManifestTags(scope, true)).toHaveLength(1)
    expect(await sql.listTemplateTagIds('first')).toEqual([])
    expect(await sql.listTemplateTagIds('second')).toEqual(['tag'])
    await sql.mutateTag({ type: 'delete', id: 'tag' }, millis(4000))
    expect(await sql.listTags()).toEqual([])
    expect(await sql.listManifestTags(scope, true)).toEqual([])
    expect(await sql.readTemplate('second')).toMatchObject({
      updatedAt: 4000,
      nodeId: null,
      name: 'second',
    })
  })

  it('rolls back conflicting renames and rejects missing assignment targets', async () => {
    const sql = make()
    await seed(sql, 'first')
    await sql.mutateTag({ type: 'create', id: 'one', name: 'One' }, millis(2000))
    await sql.mutateTag({ type: 'create', id: 'two', name: 'Two' }, millis(2000))
    await sql.mutateTag(
      { type: 'assign', id: 'one', templateId: 'first', attached: true },
      millis(2001),
    )
    await expect(
      sql.mutateTag({ type: 'rename', id: 'one', name: 'TWO' }, millis(3000)),
    ).rejects.toBeInstanceOf(TagConflictError)
    expect(await sql.readTemplate('first')).toMatchObject({ updatedAt: 2001 })
    expect(await sql.listManifestTags(scope, true)).toEqual([
      { templateId: 'first', tag: { id: 'one', name: 'One' } },
    ])
    expect(
      await sql.mutateTag(
        { type: 'assign', id: 'missing', templateId: 'first', attached: true },
        millis(3000),
      ),
    ).toBe(false)
    expect(
      await sql.mutateTag(
        { type: 'assign', id: 'one', templateId: 'missing', attached: true },
        millis(3000),
      ),
    ).toBe(false)
  })

  it('keeps unpublished and other-scope assignments out of public manifests', async () => {
    const sql = make()
    await seed(sql, 'hidden', false)
    await sql.mutateTag({ type: 'create', id: 'tag', name: 'Secret' }, millis(2000))
    await sql.mutateTag(
      { type: 'assign', id: 'tag', templateId: 'hidden', attached: true },
      millis(2001),
    )
    expect(await sql.listManifestTags(scope, false)).toEqual([])
    expect(await sql.listManifestTags({ ...scope, season: 2 }, true)).toEqual([])
    expect(await sql.listManifestTags(scope, true)).toHaveLength(1)
  })
})
