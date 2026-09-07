import { uuidV7, WORLD_TEMPLATE_SURFACE, type WorkActivity, type WorkItem } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { D1WorkStore } from './d1-store.js'
import { MemoryWorkStore } from './memory-store.js'

/** D1 serializes transactions; the in-process fake otherwise overlaps its awaited statements. */
const serialDatabase = (): SqliteD1Database => {
  const database = new SqliteD1Database()
  const batch = database.batch.bind(database)
  let pending: Promise<unknown> = Promise.resolve()
  database.batch = <T>(statements: Parameters<SqliteD1Database['batch']>[0]) => {
    const result = pending.then(() => batch<T>(statements))
    pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  return database
}

const item = (): WorkItem => ({
  id: uuidV7(),
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  title: 'Repair the border',
  description: '',
  status: 'open',
  priority: 'normal',
  tags: ['border'],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
  claimant: null,
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
})
const event = (item: WorkItem): WorkActivity => ({
  id: uuidV7(),
  action: item.revision === 1 ? 'create' : 'claim',
  actor: { wplaceUserId: 1, displayName: 'Painter' },
  item,
})

describe.each(['memory', 'd1'] as const)('%s coordination storage', (adapter) => {
  it('commits one competing claim with exactly one activity entry', async () => {
    const database = adapter === 'd1' ? serialDatabase() : null
    const store =
      database === null ? new MemoryWorkStore() : new D1WorkStore(database as unknown as D1Database)
    try {
      const initial = item()
      expect(await store.save(initial, 0, event(initial), 'a'.repeat(64))).toBe(true)
      const candidates = [1, 2].map((id) => ({
        ...initial,
        revision: 2,
        updatedAt: 2000,
        claimant: { wplaceUserId: id, displayName: `Painter ${id}` },
      }))
      const results = await Promise.all(
        candidates.map((next) => store.save(next, 1, event(next), 'a'.repeat(64))),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
      const winner = await store.read(initial.id)
      expect(winner).toEqual(candidates[results.indexOf(true)])
      const history = await store.history(initial.id, Number.MAX_SAFE_INTEGER)
      expect(history.map((entry) => entry.item.revision)).toEqual([2, 1])
      expect(history[0]?.item).toEqual(winner)
      expect(await store.history(initial.id, 2)).toHaveLength(1)
      expect(await store.list(1, WORLD_TEMPLATE_SURFACE)).toEqual([])
      expect(await store.list(0, { kind: 'alliance-headquarters', allianceId: 1 })).toEqual([])
    } finally {
      database?.close()
    }
  })

  it('rejects a stale retry without duplicating or replacing history', async () => {
    const database = adapter === 'd1' ? new SqliteD1Database() : null
    const store =
      database === null ? new MemoryWorkStore() : new D1WorkStore(database as unknown as D1Database)
    try {
      const initial = item()
      await store.save(initial, 0, event(initial), 'a'.repeat(64))
      expect(
        await store.save({ ...initial, title: 'Lost update' }, 0, event(initial), 'a'.repeat(64)),
      ).toBe(false)
      expect(await store.read(initial.id)).toEqual(initial)
      expect(await store.history(initial.id, Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    } finally {
      database?.close()
    }
  })
})
