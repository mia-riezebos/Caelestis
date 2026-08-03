import { describe, expect, it } from 'vitest'
import {
  GRACE_SECONDS,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
  type TelemetryBucket,
} from '../../ports/index.js'
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
    const store = new MemoryCounterStore(new MemorySqlStore(), () => 100_000)
    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
      { templateId: 'template-a', occurredAt: 110, placed: 7, correct: 5, repairs: 2 },
      { templateId: 'template-b', occurredAt: 100, placed: 2, correct: 2, repairs: 0 },
    ])

    await expect(store.readPending(['template-a', 'template-b'])).resolves.toEqual([
      { templateId: 'template-a', placed: 11, correct: 8, repairs: 3, flushedAt: null },
      { templateId: 'template-b', placed: 2, correct: 2, repairs: 0, flushedAt: null },
    ])
  })

  it('attributes deltas in different minutes to their event-time buckets', async () => {
    const nowSeconds = 240
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => nowSeconds * 1_000)

    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
      { templateId: 'template-a', occurredAt: 125, placed: 7, correct: 5, repairs: 2 },
    ])
    await store.alarm()

    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: 0,
        toSeconds: 180,
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: 60,
        placed: 4,
        correct: 3,
        repairs: 1,
      },
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: 120,
        placed: 7,
        correct: 5,
        repairs: 2,
      },
    ])
  })

  it('flushes only after the event bucket has closed and passed grace', async () => {
    let nowSeconds = 100
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => nowSeconds * 1_000)

    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
    ])
    expect(store.nextAlarmAt()).toBe((60 + RESOLUTION_SECONDS + GRACE_SECONDS) * 1_000)

    nowSeconds = 149
    await store.alarm()
    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: 0,
        toSeconds: 180,
      }),
    ).resolves.toEqual([])

    nowSeconds = 150
    await store.alarm()
    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: 0,
        toSeconds: 180,
      }),
    ).resolves.toHaveLength(1)
  })

  it('rewrites a retained bucket with its cumulative total after a late arrival', async () => {
    let nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => nowSeconds * 1_000)

    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    nowSeconds = 200
    await store.record([
      { templateId: 'template-a', occurredAt: 110, placed: 2, correct: 1, repairs: 1 },
    ])
    expect(store.nextAlarmAt()).toBe(nowSeconds * 1_000)
    await store.alarm()

    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: 60,
        toSeconds: 120,
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: 60,
        placed: 6,
        correct: 4,
        repairs: 2,
      },
    ])
  })

  it('drops a late arrival past retention and increments the observable count', async () => {
    let nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => nowSeconds * 1_000)

    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    nowSeconds = 60 + RESOLUTION_SECONDS + GRACE_SECONDS + RETENTION_SECONDS
    await store.record([
      { templateId: 'template-a', occurredAt: 110, placed: 2, correct: 1, repairs: 1 },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: 150_000,
      },
    ])
  })

  it('excludes retained flushed buckets from pending totals', async () => {
    const nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => nowSeconds * 1_000)

    await store.record([
      { templateId: 'template-a', occurredAt: 100, placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: 150_000,
      },
    ])
  })
})
