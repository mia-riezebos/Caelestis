import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import type { PersistedStatusReadModel } from './status-read-model/model.js'
import { StatusReadModelObject } from './status-read-model-object.js'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

let database: SqliteD1Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('status read-model Durable Object', () => {
  it('persists a reconstructible season projection across object eviction', async () => {
    database = new SqliteD1Database()
    const held = new Map<string, unknown>()
    const state = {
      storage: {
        get: async <A>(key: string) => held.get(key) as A | undefined,
        put: async (key: string, value: unknown) => {
          held.set(key, structuredClone(value))
        },
      },
    } as unknown as DurableObjectState
    const env = { DB: database } as unknown as Env

    const first = new StatusReadModelObject(state, env)
    await expect(first.reconcileSnapshot(3, 'public')).resolves.toEqual({
      cacheOutcome: 'miss',
      snapshot: { revision: 1, templates: [] },
    })
    expect((held.get('status-read-model:v1') as PersistedStatusReadModel | undefined)?.season).toBe(
      3,
    )

    const recovered = new StatusReadModelObject(state, env)
    await expect(recovered.reconcileSnapshot(3, 'admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: { revision: 1, templates: [] },
    })
  })

  it('rejects an invalid season before touching authoritative storage', async () => {
    database = new SqliteD1Database()
    const state = {
      storage: { get: vi.fn(), put: vi.fn() },
    } as unknown as DurableObjectState
    const object = new StatusReadModelObject(state, { DB: database } as unknown as Env)

    expect(() => object.reconcileSnapshot(-1, 'public')).toThrow('non-negative')
    expect(state.storage.get).not.toHaveBeenCalled()
  })
})
