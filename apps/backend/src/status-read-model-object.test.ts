import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import {
  createChunkedStatusPersistence,
  StatusReadModelObject,
} from './status-read-model-object.js'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

let database: SqliteD1Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('status read-model Durable Object', () => {
  const objectState = (
    held: Map<string, unknown>,
    maximumValueBytes = Number.POSITIVE_INFINITY,
  ) => {
    const storage = (target: Map<string, unknown>) => ({
      get: async <A>(key: string) => target.get(key) as A | undefined,
      put: async (key: string, value: unknown) => {
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumValueBytes) {
          throw new RangeError('value exceeds Durable Object storage limit')
        }
        target.set(key, structuredClone(value))
      },
      delete: async (key: string) => target.delete(key),
    })
    return {
      storage: {
        ...storage(held),
        transaction: async (run: (transaction: ReturnType<typeof storage>) => Promise<void>) => {
          const staged = new Map(held)
          await run(storage(staged))
          held.clear()
          for (const [key, value] of staged) held.set(key, value)
        },
      },
    } as unknown as DurableObjectState
  }

  it('persists a reconstructible season projection across object eviction', async () => {
    database = new SqliteD1Database()
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const env = { DB: database } as unknown as Env

    const first = new StatusReadModelObject(state, env)
    await expect(first.reconcileSnapshot(3, 'public')).resolves.toEqual({
      cacheOutcome: 'miss',
      snapshot: { revision: 1, templates: [] },
    })
    expect(held.get('status-read-model:v2:manifest')).toMatchObject({ season: 3, revision: 1 })

    const recovered = new StatusReadModelObject(state, env)
    await expect(recovered.reconcileSnapshot(3, 'admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: { revision: 1, templates: [] },
    })
  })

  it('chunks a valid projection larger than the per-value storage limit and reconstructs it', async () => {
    const statuses = Array.from({ length: 18_000 }, (_, index) => ({
      templateId: `01890f3e-7b2c-7abc-8def-${String(index).padStart(12, '0')}`,
      correct: index,
      wrong: 0,
      blank: 1,
      total: index + 1,
      colours: [{ index: 0, correct: index, wrong: 0, blank: 1, total: index + 1 }],
      observedAt: millis(1_750_000_000_000),
    }))
    expect(new TextEncoder().encode(JSON.stringify(statuses)).byteLength).toBeGreaterThan(
      2 * 1024 * 1024,
    )
    const held = new Map<string, unknown>()
    const state = objectState(held, 2 * 1024 * 1024)
    const persistence = createChunkedStatusPersistence(state.storage, 4)

    await persistence.save({
      season: 4,
      revision: 1,
      reconciledAt: 1_750_000_000_000,
      publicTemplates: statuses,
      adminTemplates: statuses,
    })
    expect([...held.keys()].filter((key) => key.includes(':public:')).length).toBeGreaterThan(1)

    const recovered = createChunkedStatusPersistence(state.storage, 4)
    await expect(recovered.load()).resolves.toMatchObject({
      season: 4,
      revision: 1,
      publicTemplates: statuses,
      adminTemplates: statuses,
    })
  })

  it('keeps the previously published manifest reconstructible when a chunk transaction fails', async () => {
    const held = new Map<string, unknown>()
    const state = objectState(held)
    const first = createChunkedStatusPersistence(state.storage, 5)
    const initial = {
      season: 5,
      revision: 1,
      reconciledAt: 1_750_000_000_000,
      publicTemplates: [],
      adminTemplates: [],
    }
    await first.save(initial)
    await first.load()
    const transaction = state.storage.transaction.bind(state.storage)
    state.storage.transaction = vi.fn(async () => Promise.reject(new Error('storage failed')))

    await expect(
      first.save({ ...initial, revision: 2, reconciledAt: initial.reconciledAt + 1 }),
    ).rejects.toThrow('storage failed')
    state.storage.transaction = transaction

    const recovered = createChunkedStatusPersistence(state.storage, 5)
    await expect(recovered.load()).resolves.toMatchObject({ revision: 1 })
  })

  it('rejects an invalid season before touching authoritative storage', async () => {
    database = new SqliteD1Database()
    const state = objectState(new Map())
    const get = vi.spyOn(state.storage, 'get')
    const object = new StatusReadModelObject(state, { DB: database } as unknown as Env)

    expect(() => object.reconcileSnapshot(-1, 'public')).toThrow('non-negative')
    expect(get).not.toHaveBeenCalled()
  })
})
