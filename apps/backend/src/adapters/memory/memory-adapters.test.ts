import { describe, expect, it } from 'vitest'
import type { TelemetryBucket } from '../../ports/index.js'
import { MemoryBlobStore } from './memory-blob-store.js'
import { MemoryCounterStore } from './memory-counter-store.js'
import { MemorySqlStore } from './memory-sql-store.js'

describe('memory adapters', () => {
  it('hasAll returns exactly the hashes present in the requested namespace', async () => {
    const store = new MemoryBlobStore()
    await store.put('tiles', 'present-a', new Uint8Array([1]))
    await store.put('tiles', 'present-b', new Uint8Array([2]))
    await store.put('chunks', 'wrong-namespace', new Uint8Array([3]))

    const present = await store.hasAll('tiles', [
      'present-a',
      'missing',
      'wrong-namespace',
      'present-b',
    ])

    expect(present).toEqual(new Set(['present-a', 'present-b']))
  })

  it('appendBuckets replaces a repeated bucket with the later values', async () => {
    const store = new MemorySqlStore()
    const original: TelemetryBucket = {
      templateId: 'template-a',
      resolution: 60,
      bucketStart: 1_800,
      placed: 4,
      correct: 3,
      repairs: 1,
    }
    const later: TelemetryBucket = {
      ...original,
      placed: 9,
      correct: 8,
      repairs: 2,
    }

    await store.appendBuckets([original])
    await store.appendBuckets([later])

    await expect(
      store.readBuckets({
        templateIds: ['template-a'],
        resolution: 60,
        fromSeconds: 1_800,
        toSeconds: 1_860,
      }),
    ).resolves.toEqual([later])
  })

  it('counters read back all recorded deltas exactly', async () => {
    const store = new MemoryCounterStore()
    await store.record([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1 },
      { templateId: 'template-a', placed: 7, correct: 5, repairs: 2 },
      { templateId: 'template-b', placed: 2, correct: 2, repairs: 0 },
    ])

    await expect(store.readPending(['template-a', 'template-b'])).resolves.toEqual([
      { templateId: 'template-a', placed: 11, correct: 8, repairs: 3, flushedAt: null },
      { templateId: 'template-b', placed: 2, correct: 2, repairs: 0, flushedAt: null },
    ])
  })
})
