import { millis, seconds } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../src/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { isValidCounterDelta } from '../src/ports/counter-delta.js'
import { runTileBlobGc } from '../src/telemetry/tile-blobs.js'

class FailingOnceBlobStore extends MemoryBlobStore {
  private failed = false

  override async delete(
    namespace: 'chunks' | 'tiles' | 'derived' | 'archives',
    keys: readonly string[],
  ) {
    if (namespace === 'tiles' && !this.failed) {
      this.failed = true
      throw new Error(`temporary delete failure for ${keys.join(',')}`)
    }
    await super.delete(namespace, keys)
  }
}

describe('portable port contracts', () => {
  it('copies blob bytes and provides stable cursor pagination', async () => {
    const blobs = new MemoryBlobStore()
    const original = new Uint8Array([1])
    await blobs.put('tiles', 'b', original)
    original[0] = 9
    await blobs.put('tiles', 'a', new Uint8Array([2]))
    await blobs.put('tiles', 'c', new Uint8Array([3]))

    expect(await blobs.get('tiles', 'b')).toEqual(new Uint8Array([1]))
    expect(await blobs.list('tiles', { limit: 2 })).toEqual({ keys: ['a', 'b'], cursor: 'b' })
    expect(await blobs.list('tiles', { cursor: 'b', limit: 2 })).toEqual({ keys: ['c'] })
  })

  it('rejects impossible, expired, and overly future counter deltas', () => {
    const now = seconds(10_000)
    const valid = {
      templateId: 'template',
      occurredAt: seconds(9_990),
      placed: 2,
      correct: 1,
      repairs: 1,
    }

    expect(isValidCounterDelta(valid, now)).toBe(true)
    expect(isValidCounterDelta({ ...valid, correct: 3 }, now)).toBe(false)
    expect(isValidCounterDelta({ ...valid, occurredAt: seconds(10_031) }, now)).toBe(false)
    expect(isValidCounterDelta({ ...valid, occurredAt: seconds(1) }, now)).toBe(false)
  })

  it('makes repeated counter delivery idempotent before its bucket flushes', async () => {
    const sql = new MemorySqlStore()
    const counters = new MemoryCounterStore(sql, () => millis(120_000))
    const delta = {
      templateId: 'template',
      occurredAt: seconds(120),
      placed: 3,
      correct: 2,
      repairs: 1,
    }

    await counters.record([delta], 'delivery-1')
    await counters.record([delta], 'delivery-1')

    expect(await counters.readPending(['template'])).toEqual([
      { templateId: 'template', placed: 3, correct: 2, repairs: 1, flushedAt: null },
    ])
  })

  it('only deletes unreferenced tile blobs when delete mode is explicitly selected', async () => {
    const sql = new MemorySqlStore()
    const blobs = new MemoryBlobStore()
    const hash = 'a'.repeat(64)
    await blobs.put('tiles', hash, new Uint8Array([7]))

    await runTileBlobGc({ sql, blobs }, { mode: 'dry-run', now: millis(10) })
    expect(await blobs.get('tiles', hash)).toEqual(new Uint8Array([7]))

    const report = await runTileBlobGc({ sql, blobs }, { mode: 'delete', now: millis(20) })
    expect(report.reclaimed).toBe(1)
    expect(await blobs.get('tiles', hash)).toBeNull()
  })

  it('leaves a failed blob deletion fenced for the next bounded GC retry', async () => {
    const sql = new MemorySqlStore()
    const blobs = new FailingOnceBlobStore()
    const hash = 'b'.repeat(64)
    await blobs.put('tiles', hash, new Uint8Array([8]))

    expect((await runTileBlobGc({ sql, blobs }, { mode: 'delete', now: millis(10) })).failed).toBe(
      1,
    )
    expect(await blobs.get('tiles', hash)).toEqual(new Uint8Array([8]))
    expect(
      (await runTileBlobGc({ sql, blobs }, { mode: 'delete', now: millis(20) })).reclaimed,
    ).toBe(1)
    expect(await blobs.get('tiles', hash)).toBeNull()
  })
})
