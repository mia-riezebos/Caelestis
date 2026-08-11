import { millis } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeRecord, SqlStore, TemplateVersionRecord } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const node = (id: string, path: string, parentId: string | null, season = 1): NodeRecord => ({
  id,
  season,
  parentId,
  path,
  name: id,
  description: null,
  createdAt: millis(1_000),
})

const version = (
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
  createdAt: millis(1_000),
  bbox: { minX: 0, minY: 0, maxX: hashes.length, maxY: 1 },
  totalPixels: hashes.length,
  chunks: hashes.map((hash, tileX) => ({ tileX, tileY: 0, hash })),
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

describe.each(adapters)('$name node cascade contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('counts and removes a three-level subtree without touching a neighbouring tree', async () => {
    await store.insertNode(node('root', '/root', null))
    await store.insertNode(node('child', '/root/child', 'root'))
    await store.insertNode(node('grandchild', '/root/child/grandchild', 'child'))
    await store.insertNode(node('outside', '/outside', null))

    const shared = 'a'.repeat(64)
    const orphaned = 'b'.repeat(64)
    await store.insertTemplateVersion(version('root-template', 'root', 'root-version', [shared]))
    await store.insertTemplateVersion(
      version('deep-template', 'grandchild', 'deep-version', [shared, orphaned]),
    )
    await store.insertTemplateVersion(
      version('outside-template', 'outside', 'outside-version', [shared]),
    )

    const count = await store.countNodeSubtree('root')
    expect(count).toEqual({ nodes: 3, templates: 2 })

    const deleted = await store.deleteNodeCascade('root')
    expect(deleted).toMatchObject(count)
    expect(new Set(deleted.hashes)).toEqual(new Set([shared, orphaned]))
    await expect(store.unreferencedHashes(deleted.hashes)).resolves.toEqual([orphaned])

    await expect(store.readNode('root')).resolves.toBeNull()
    await expect(store.readNode('child')).resolves.toBeNull()
    await expect(store.readNode('grandchild')).resolves.toBeNull()
    await expect(store.readTemplate('root-template')).resolves.toBeNull()
    await expect(store.readTemplateVersion('deep-version')).resolves.toBeNull()
    await expect(store.readNode('outside')).resolves.not.toBeNull()
    await expect(store.readTemplate('outside-template')).resolves.not.toBeNull()
    await expect(store.readTemplateVersion('outside-version')).resolves.not.toBeNull()
  })
})
