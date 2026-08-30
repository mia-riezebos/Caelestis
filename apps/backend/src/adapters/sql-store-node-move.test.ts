import { millis } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeRecord, SqlStore, TemplateVersionRecord } from '../ports/index.js'
import { InvalidNodeParentError, NodePathConflictError } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const node = (id: string, path: string, parentId: string | null, season = 1): NodeRecord => ({
  id,
  season,
  parentId,
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  description: null,
  createdAt: millis(1_000),
})

const version = (nodeId: string): TemplateVersionRecord => ({
  templateId: 'template',
  surface: { kind: 'world', allianceId: null },
  season: 1,
  nodeId,
  name: 'Template',
  versionId: 'version',
  createdWithToken: 'a'.repeat(64),
  createdByUserId: null,
  createdAt: millis(1_000),
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash: 'a'.repeat(64) }],
})

type Harness = { store: SqlStore; close(): void }

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => ({ store: new MemorySqlStore(), close: () => undefined }),
  },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      return {
        store: new D1SqlStore(database as unknown as D1Database),
        close: () => database.close(),
      }
    },
  },
]

describe.each(adapters)('$name node move contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('re-parents a node and rewrites descendants two levels deep without moving its template', async () => {
    await store.insertNode(node('destination', '/destination', null))
    await store.insertNode(node('source', '/source', null))
    await store.insertNode(node('child', '/source/child', 'source'))
    await store.insertNode(node('grandchild', '/source/child/grandchild', 'child'))
    await store.insertTemplateVersion(version('source'))

    await expect(store.moveNode('source', 'destination', '/destination/source')).resolves.toBe(true)

    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: 'destination',
      path: '/destination/source',
    })
    await expect(store.readNode('child')).resolves.toMatchObject({
      parentId: 'source',
      path: '/destination/source/child',
    })
    await expect(store.readNode('grandchild')).resolves.toMatchObject({
      parentId: 'child',
      path: '/destination/source/child/grandchild',
    })
    // Templates point at node ids rather than materialized paths, so the move must not alter their
    // identity or make their current version disappear.
    await expect(store.readTemplate('template')).resolves.toMatchObject({ nodeId: 'source' })
    await expect(store.readTemplateVersion('version')).resolves.toMatchObject({ nodeId: 'source' })
  })

  it('refuses to move a node into its own descendant and changes nothing', async () => {
    await store.insertNode(node('root', '/root', null))
    await store.insertNode(node('child', '/root/child', 'root'))
    await store.insertNode(node('grandchild', '/root/child/grandchild', 'child'))
    const before = await store.listNodes(1)

    await expect(
      store.moveNode('root', 'grandchild', '/root/child/grandchild/root'),
    ).rejects.toBeInstanceOf(InvalidNodeParentError)
    await expect(store.listNodes(1)).resolves.toEqual(before)
  })

  it('counts the node itself as an invalid destination', async () => {
    await store.insertNode(node('source', '/source', null))

    await expect(store.moveNode('source', 'source', '/source/source')).rejects.toBeInstanceOf(
      InvalidNodeParentError,
    )
    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: null,
      path: '/source',
    })
  })

  it('refuses a destination that does not exist', async () => {
    await store.insertNode(node('source', '/source', null))

    await expect(store.moveNode('source', 'missing', '/missing/source')).rejects.toThrow(
      'parent node does not exist',
    )
    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: null,
      path: '/source',
    })
  })

  it('refuses a destination in another season', async () => {
    await store.insertNode(node('source', '/source', null, 1))
    await store.insertNode(node('other-season', '/destination', null, 2))

    await expect(store.moveNode('source', 'other-season', '/destination/source')).rejects.toThrow(
      'parent node belongs to a different season',
    )
    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: null,
      path: '/source',
    })
  })

  it('refuses a path occupied by a sibling at the destination', async () => {
    await store.insertNode(node('destination', '/destination', null))
    await store.insertNode(node('occupied', '/destination/source', 'destination'))
    await store.insertNode(node('source', '/source', null))

    await expect(
      store.moveNode('source', 'destination', '/destination/source'),
    ).rejects.toBeInstanceOf(NodePathConflictError)
    await expect(store.readNode('source')).resolves.toMatchObject({
      parentId: null,
      path: '/source',
    })
  })

  it('moves a node to the top level with a one-segment path', async () => {
    await store.insertNode(node('parent', '/parent', null))
    await store.insertNode(node('child', '/parent/child', 'parent'))

    await expect(store.moveNode('child', null, '/child')).resolves.toBe(true)
    await expect(store.readNode('child')).resolves.toMatchObject({ parentId: null, path: '/child' })
  })

  it('keeps the live segment when a parent-only move receives a stale proposed path', async () => {
    await store.insertNode(node('destination', '/destination', null))
    await store.insertNode({ ...node('source', '/beta', null), name: 'Beta' })

    await expect(store.moveNode('source', 'destination', '/destination/alpha')).resolves.toBe(true)

    await expect(store.readNode('source')).resolves.toMatchObject({
      name: 'Beta',
      parentId: 'destination',
      path: '/destination/beta',
    })
  })
})
