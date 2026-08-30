import { millis, type TemplateSurface } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqlStore, TemplateVersionRecord } from '../ports/index.js'
import { TemplateIdentityError } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const version = (surface: TemplateSurface, versionId = 'version-1'): TemplateVersionRecord => ({
  templateId: 'template-1',
  surface,
  season: 1,
  nodeId: null,
  name: 'Alliance art',
  versionId,
  createdWithToken: 'a'.repeat(64),
  createdByUserId: null,
  createdAt: millis(versionId === 'version-1' ? 1_000 : 2_000),
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
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

describe.each(adapters)('$name template surface contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('round-trips alliance surface identity', async () => {
    const surface = { kind: 'alliance-picture', allianceId: 535_245 } as const
    await store.insertTemplateVersion(version(surface))

    await expect(store.readTemplate('template-1')).resolves.toMatchObject({ surface })
    await expect(store.readTemplateVersion('version-1')).resolves.toMatchObject({ surface })
  })

  it('keeps alliance templates out of world alarm scans', async () => {
    await store.insertTemplateVersion(
      version({ kind: 'alliance-headquarters', allianceId: 535_245 }),
    )

    await expect(store.listAlarmTiles(1)).resolves.toEqual([])
  })

  it('does not let a replacement version cross surfaces', async () => {
    await store.insertTemplateVersion(version({ kind: 'alliance-picture', allianceId: 535_245 }))

    await expect(
      store.insertTemplateVersion(
        version({ kind: 'alliance-banner', allianceId: 535_245 }, 'version-2'),
        { requireExisting: true },
      ),
    ).rejects.toBeInstanceOf(TemplateIdentityError)
  })
})
