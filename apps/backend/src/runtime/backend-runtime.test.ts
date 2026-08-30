import { millis } from '@caelestis/shared'
import { Context, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { Ports } from '../ports/index.js'
import {
  BlobStoreService,
  CounterStoreService,
  createBackendRuntime,
  layerFromPorts,
  SqlStoreService,
} from './backend-runtime.js'

const makePorts = (): Ports => {
  const sql = new MemorySqlStore()
  return {
    blobs: new MemoryBlobStore(),
    sql,
    counters: new MemoryCounterStore(sql, () => millis(0)),
  }
}

describe('backend runtime', () => {
  it('bridges existing ports into stable Context services', async () => {
    const ports = makePorts()
    const runtime = createBackendRuntime(ports)

    expect(Context.get(runtime.context, BlobStoreService)).toBe(ports.blobs)
    expect(Context.get(runtime.context, SqlStoreService)).toBe(ports.sql)
    expect(Context.get(runtime.context, CounterStoreService)).toBe(ports.counters)

    const resolved = await runtime.run(
      Effect.gen(function* () {
        return {
          blobs: yield* BlobStoreService,
          sql: yield* SqlStoreService,
          counters: yield* CounterStoreService,
        }
      }),
    )
    expect(resolved).toEqual(ports)
  })

  it('builds an explicit layer from memory adapters', async () => {
    const ports = makePorts()
    const program = Effect.gen(function* () {
      return yield* SqlStoreService
    })

    await expect(Effect.runPromise(Effect.provide(program, layerFromPorts(ports)))).resolves.toBe(
      ports.sql,
    )
  })
})
