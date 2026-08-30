import { millis } from '@caelestis/shared'
import { Context, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import {
  BlobStoreService,
  CounterStoreService,
  createBackendRuntime,
  makeBackendContext,
  makeBackendLayer,
  SqlStoreService,
} from './backend-runtime.js'

const makeAdapters = () => {
  const sql = new MemorySqlStore()
  return {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(0)),
  }
}

describe('backend runtime', () => {
  it('assembles stable Context services explicitly', async () => {
    const adapters = makeAdapters()
    const context = makeBackendContext(adapters.blobs, adapters.sql, adapters.counters)
    const runtime = createBackendRuntime(context)

    expect(Context.get(runtime.context, BlobStoreService)).toBe(adapters.blobs)
    expect(Context.get(runtime.context, SqlStoreService)).toBe(adapters.sql)
    expect(Context.get(runtime.context, CounterStoreService)).toBe(adapters.counters)

    const resolved = await runtime.run(
      Effect.gen(function* () {
        return {
          blobs: yield* BlobStoreService,
          sql: yield* SqlStoreService,
          counters: yield* CounterStoreService,
        }
      }),
    )
    expect(resolved).toEqual(adapters)
  })

  it('builds an explicit layer from memory adapters', async () => {
    const adapters = makeAdapters()
    const program = Effect.gen(function* () {
      return yield* SqlStoreService
    })

    await expect(
      Effect.runPromise(
        Effect.provide(program, makeBackendLayer(adapters.blobs, adapters.sql, adapters.counters)),
      ),
    ).resolves.toBe(adapters.sql)
  })
})
