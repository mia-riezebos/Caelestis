import { millis, type Seconds, seconds } from '@wts/shared'
import { describe, expect, it } from 'vitest'
import {
  type BucketQuery,
  FLUSH_BATCH_LIMIT,
  GRACE_SECONDS,
  MAX_COUNTER_DELTA_VALUE,
  MAX_COUNTER_DELTAS_PER_RECORD,
  MAX_TEMPLATE_ID_LENGTH,
  type Ports,
  RESOLUTION_SECONDS,
  RETENTION_SECONDS,
  type SqlStore,
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
      bucketStart: seconds(1_800),
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
        fromSeconds: seconds(1_800),
        toSeconds: seconds(1_860),
      }),
    ).resolves.toEqual([later])
  })

  it('counters read back all recorded deltas exactly', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))
    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
      { templateId: 'template-a', occurredAt: seconds(110), placed: 7, correct: 5, repairs: 2 },
      { templateId: 'template-b', occurredAt: seconds(100), placed: 2, correct: 2, repairs: 0 },
    ])

    await expect(store.readPending(['template-a', 'template-b'])).resolves.toEqual([
      { templateId: 'template-a', placed: 11, correct: 8, repairs: 3, flushedAt: null },
      { templateId: 'template-b', placed: 2, correct: 2, repairs: 0, flushedAt: null },
    ])
  })

  it('shares flushed counter history with the SqlStore exposed through Ports', async () => {
    const nowSeconds = 150
    const sql = new MemorySqlStore()
    const counters = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))
    const ports: Ports = {
      blobs: new MemoryBlobStore(),
      sql,
      counters,
    }

    await ports.counters.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await counters.alarm()

    await expect(
      ports.sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(60),
        toSeconds: seconds(120),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(60),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
    ])
  })

  it('rejects a far-future event without adding it to pending counters', async () => {
    const nowSeconds = 100
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(nowSeconds * 1_000))

    await store.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(nowSeconds + GRACE_SECONDS + 1),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
    ])

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    expect(store.nextAlarmAt()).toBeNull()
  })

  it('rejects a negative counter', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: -1, correct: 0, repairs: 0 },
    ])

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
    await expect(store.readDroppedLateCount()).resolves.toBe(1)
  })

  it('rejects every counter magnitude above the per-delta limit', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))

    await store.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: MAX_COUNTER_DELTA_VALUE + 1,
        correct: 0,
        repairs: 0,
      },
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: MAX_COUNTER_DELTA_VALUE,
        correct: MAX_COUNTER_DELTA_VALUE + 1,
        repairs: 0,
      },
      {
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: MAX_COUNTER_DELTA_VALUE,
        correct: MAX_COUNTER_DELTA_VALUE,
        repairs: MAX_COUNTER_DELTA_VALUE + 1,
      },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(3)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
  })

  it('rejects counters that do not satisfy repairs <= correct <= placed', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 0, correct: 1, repairs: 1 },
      { templateId: 'template-a', occurredAt: seconds(100), placed: 2, correct: 1, repairs: 2 },
      { templateId: 'template-a', occurredAt: seconds(100), placed: 3, correct: 2, repairs: 1 },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(2)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 3, correct: 2, repairs: 1, flushedAt: null },
    ])
  })

  it('rejects template ids above the length limit', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))
    const acceptedId = 'a'.repeat(MAX_TEMPLATE_ID_LENGTH)
    const rejectedId = 'b'.repeat(MAX_TEMPLATE_ID_LENGTH + 1)

    await store.record([
      { templateId: rejectedId, occurredAt: seconds(100), placed: 1, correct: 1, repairs: 0 },
      { templateId: acceptedId, occurredAt: seconds(100), placed: 1, correct: 1, repairs: 0 },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending([acceptedId, rejectedId])).resolves.toEqual([
      { templateId: acceptedId, placed: 1, correct: 1, repairs: 0, flushedAt: null },
      { templateId: rejectedId, placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
  })

  it('caps work per record call and counts only the excess deltas as rejected', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))
    const deltas = Array.from({ length: MAX_COUNTER_DELTAS_PER_RECORD + 1 }, () => ({
      templateId: 'template-a',
      occurredAt: seconds(100),
      placed: 1,
      correct: 1,
      repairs: 0,
    }))

    await store.record(deltas)

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: MAX_COUNTER_DELTAS_PER_RECORD,
        correct: MAX_COUNTER_DELTAS_PER_RECORD,
        repairs: 0,
        flushedAt: null,
      },
    ])
  })

  it('rejects a NaN event time', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))

    await store.record([
      {
        templateId: 'template-a',
        occurredAt: Number.NaN as unknown as Seconds,
        placed: 1,
        correct: 1,
        repairs: 0,
      },
    ])

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
    await expect(store.readDroppedLateCount()).resolves.toBe(1)
  })

  it('records valid deltas from a batch that also contains an invalid delta', async () => {
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(100_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: -1, correct: 0, repairs: 0 },
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
    await expect(store.readDroppedLateCount()).resolves.toBe(1)
  })

  it('attributes deltas in different minutes to their event-time buckets', async () => {
    const nowSeconds = 240
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
      { templateId: 'template-a', occurredAt: seconds(125), placed: 7, correct: 5, repairs: 2 },
    ])
    await store.alarm()

    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(0),
        toSeconds: seconds(180),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(60),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(120),
        placed: 7,
        correct: 5,
        repairs: 2,
      },
    ])
  })

  it('flushes only after the event bucket has closed and passed grace', async () => {
    let nowSeconds = 100
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    expect(store.nextAlarmAt()).toBe((60 + RESOLUTION_SECONDS + GRACE_SECONDS) * 1_000)

    nowSeconds = 149
    await store.alarm()
    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(0),
        toSeconds: seconds(180),
      }),
    ).resolves.toEqual([])

    nowSeconds = 150
    await store.alarm()
    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(0),
        toSeconds: seconds(180),
      }),
    ).resolves.toHaveLength(1)
  })

  it('clears the alarm after all pending counters have flushed', async () => {
    const nowSeconds = 150
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    expect(store.nextAlarmAt()).toBeNull()
  })

  it('retries the same flush batch after appendBuckets fails', async () => {
    let nowSeconds = 100
    let shouldReject = true
    const attempts: TelemetryBucket[][] = []
    const successfulWrites: TelemetryBucket[][] = []
    const sql: SqlStore = {
      async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
        const snapshot = buckets.map((bucket) => ({ ...bucket }))
        attempts.push(snapshot)
        if (shouldReject) {
          shouldReject = false
          throw new Error('D1 unavailable')
        }
        successfulWrites.push(snapshot)
      },
      async readBuckets(_query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return []
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    const preFailureAlarm = store.nextAlarmAt()
    nowSeconds = 200

    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(store.nextAlarmAt()).toBe(201_000)
    expect(store.nextAlarmAt()).not.toBe(preFailureAlarm)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])

    nowSeconds = 201
    await store.alarm()

    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(successfulWrites).toEqual([attempts[0]])
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: millis(201_000) },
    ])
    expect(store.nextAlarmAt()).toBeNull()
  })

  it('readPending re-arms an alarm for flush-batch residue', async () => {
    let nowSeconds = 100
    const sql: SqlStore = {
      async appendBuckets(_buckets: readonly TelemetryBucket[]): Promise<void> {
        throw new Error('D1 unavailable')
      },
      async readBuckets(_query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return []
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    nowSeconds = 200
    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(store.nextAlarmAt()).toBe(201_000)

    nowSeconds = 200.5
    await store.readPending(['template-a'])

    expect(store.nextAlarmAt()).toBe(201_000)
  })

  it('backs off consecutive flush failures and resets after a success', async () => {
    let nowSeconds = 100
    let attempt = 0
    const sql: SqlStore = {
      async appendBuckets(_buckets: readonly TelemetryBucket[]): Promise<void> {
        attempt += 1
        if (attempt === 1 || attempt === 2 || attempt === 4) {
          throw new Error('D1 unavailable')
        }
      },
      async readBuckets(_query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return []
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    nowSeconds = 200
    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(store.nextAlarmAt()).toBe(201_000)

    nowSeconds = 201
    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(store.nextAlarmAt()).toBe(203_000)

    nowSeconds = 203
    await store.alarm()
    expect(store.nextAlarmAt()).toBeNull()

    await store.record([
      { templateId: 'template-b', occurredAt: seconds(203), placed: 2, correct: 1, repairs: 0 },
    ])
    nowSeconds = 270
    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(store.nextAlarmAt()).toBe(271_000)
  })

  it('measures retry backoff from failure time and caps it at 60 seconds', async () => {
    let nowMilliseconds = 100_000
    const sql: SqlStore = {
      async appendBuckets(_buckets: readonly TelemetryBucket[]): Promise<void> {
        nowMilliseconds += 61_000
        throw new Error('D1 unavailable')
      },
      async readBuckets(_query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return []
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowMilliseconds))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    nowMilliseconds = 200_000

    for (const expectedDelay of [1, 2, 4, 8, 16, 32, 60, 60]) {
      await expect(store.alarm()).rejects.toThrow('D1 unavailable')
      expect(store.nextAlarmAt()).toBe(nowMilliseconds + expectedDelay * 1_000)
      nowMilliseconds = store.nextAlarmAt() as number
    }
  })

  it('rewrites a retained bucket with its cumulative total after a late arrival', async () => {
    let nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    nowSeconds = 200
    await store.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 1 },
    ])
    expect(store.nextAlarmAt()).toBe(nowSeconds * 1_000)
    await store.alarm()

    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(60),
        toSeconds: seconds(120),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(60),
        placed: 6,
        correct: 4,
        repairs: 2,
      },
    ])
  })

  it('absorbs a late arrival just before retention expires while its bucket remains pending', async () => {
    let nowSeconds = 150
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])

    nowSeconds = 60 + RESOLUTION_SECONDS + GRACE_SECONDS + RETENTION_SECONDS - 1
    await store.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 1 },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(0)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 6,
        correct: 4,
        repairs: 2,
        flushedAt: null,
      },
    ])
  })

  it('rejects a long-expired bucket whose only trace is an unpruned retained row', async () => {
    let nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    nowSeconds += 30 * 24 * 60 * 60
    await store.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 1 },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: millis(150_000),
      },
    ])
    await store.alarm()
    await expect(
      sql.readBuckets({
        templateIds: ['template-a'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(60),
        toSeconds: seconds(120),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(60),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
    ])
  })

  it('rejects a boundary delta because the exact expiry instant is exclusive', async () => {
    const bucketStart = 60
    const nowSeconds = bucketStart + RESOLUTION_SECONDS + GRACE_SECONDS + RETENTION_SECONDS
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(nowSeconds * 1_000))
    const internals = store as unknown as {
      flushBatch: Map<
        string,
        {
          templateId: string
          bucketStart: number
          placed: number
          correct: number
          repairs: number
        }
      >
    }
    // Model the crash point after pending promotion created flush_batch but before retained was
    // written; the public API has no state-import hook because this adapter is otherwise in-memory.
    internals.flushBatch.set(`template-a\u0000${bucketStart}`, {
      templateId: 'template-a',
      bucketStart,
      placed: 4,
      correct: 3,
      repairs: 1,
    })

    await store.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(bucketStart + 1),
        placed: 2,
        correct: 1,
        repairs: 1,
      },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
  })

  it('flushes more than the D1-safe chunk limit across alarms without loss or duplication', async () => {
    const nowSeconds = 10_000
    const persisted = new MemorySqlStore()
    const batches: TelemetryBucket[][] = []
    const sql: SqlStore = {
      async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
        batches.push(buckets.map((bucket) => ({ ...bucket })))
        await persisted.appendBuckets(buckets)
      },
      readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return persisted.readBuckets(query)
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))
    const templateIds = Array.from(
      { length: FLUSH_BATCH_LIMIT + 5 },
      (_, index) => `template-${index.toString().padStart(2, '0')}`,
    )

    await store.record(
      templateIds.map((templateId) => ({
        templateId,
        occurredAt: seconds(9_950),
        placed: 1,
        correct: 1,
        repairs: 0,
      })),
    )
    await store.alarm()
    expect(batches.map((batch) => batch.length)).toEqual([FLUSH_BATCH_LIMIT])
    expect(store.nextAlarmAt()).toBe(nowSeconds * 1_000)

    await store.alarm()
    expect(batches.map((batch) => batch.length)).toEqual([FLUSH_BATCH_LIMIT, 5])
    expect(store.nextAlarmAt()).toBeNull()
    expect(new Set(batches.flat().map((bucket) => bucket.templateId))).toEqual(new Set(templateIds))
    await expect(
      sql.readBuckets({
        templateIds,
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(9_900),
        toSeconds: seconds(9_960),
      }),
    ).resolves.toHaveLength(FLUSH_BATCH_LIMIT + 5)
  })

  it('preserves a partially drained chunk backlog across a D1 failure', async () => {
    let nowSeconds = 10_000
    let appendAttempt = 0
    const persisted = new MemorySqlStore()
    const batches: TelemetryBucket[][] = []
    const sql: SqlStore = {
      async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
        appendAttempt += 1
        batches.push(buckets.map((bucket) => ({ ...bucket })))
        if (appendAttempt === 2) throw new Error('D1 unavailable')
        await persisted.appendBuckets(buckets)
      },
      readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return persisted.readBuckets(query)
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))
    const templateIds = Array.from(
      { length: FLUSH_BATCH_LIMIT + 5 },
      (_, index) => `template-${index.toString().padStart(2, '0')}`,
    )

    await store.record(
      templateIds.map((templateId) => ({
        templateId,
        occurredAt: seconds(9_950),
        placed: 1,
        correct: 1,
        repairs: 0,
      })),
    )
    await store.alarm()
    await store.record([
      { templateId: 'template-00', occurredAt: seconds(9_950), placed: 1, correct: 1, repairs: 0 },
    ])

    await expect(store.alarm()).rejects.toThrow('D1 unavailable')
    expect(batches.map((batch) => batch.length)).toEqual([FLUSH_BATCH_LIMIT, 5])
    await expect(store.readPending(['template-00', 'template-40'])).resolves.toEqual([
      {
        templateId: 'template-00',
        placed: 1,
        correct: 1,
        repairs: 0,
        flushedAt: millis(10_000_000),
      },
      { templateId: 'template-40', placed: 1, correct: 1, repairs: 0, flushedAt: null },
    ])

    nowSeconds += 1
    await store.alarm()
    await store.alarm()

    expect(batches.map((batch) => batch.length)).toEqual([FLUSH_BATCH_LIMIT, 5, 5, 1])
    await expect(
      sql.readBuckets({
        templateIds,
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(9_900),
        toSeconds: seconds(9_960),
      }),
    ).resolves.toHaveLength(FLUSH_BATCH_LIMIT + 5)
    await expect(
      sql.readBuckets({
        templateIds: ['template-00'],
        resolution: RESOLUTION_SECONDS,
        fromSeconds: seconds(9_900),
        toSeconds: seconds(9_960),
      }),
    ).resolves.toEqual([
      {
        templateId: 'template-00',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(9_900),
        placed: 2,
        correct: 2,
        repairs: 0,
      },
    ])
  })

  it('flushes a template-first sorted chunk across bucket starts (the Durable Object is unverified — see #27)', async () => {
    const nowSeconds = 10_000
    const batches: TelemetryBucket[][] = []
    const sql: SqlStore = {
      async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
        batches.push(buckets.map((bucket) => ({ ...bucket })))
      },
      async readBuckets(_query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return []
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))
    const templateIds = ['template-a', 'template-b']
    const bucketStarts = Array.from({ length: 30 }, (_, index) => 8_160 + index * 60)

    await store.record(
      templateIds.toReversed().flatMap((templateId) =>
        bucketStarts.toReversed().map((bucketStart) => ({
          templateId,
          occurredAt: seconds(bucketStart + 1),
          placed: 1,
          correct: 1,
          repairs: 0,
        })),
      ),
    )
    await store.alarm()

    expect(batches[0]?.map(({ templateId, bucketStart }) => ({ templateId, bucketStart }))).toEqual(
      [
        ...bucketStarts.map((bucketStart) => ({ templateId: 'template-a', bucketStart })),
        ...bucketStarts
          .slice(0, FLUSH_BATCH_LIMIT - bucketStarts.length)
          .map((bucketStart) => ({ templateId: 'template-b', bucketStart })),
      ],
    )
  })

  it('drops an expired bucket with no local trace at the validation edge', async () => {
    const bucketStart = 60
    const nowSeconds = bucketStart + RESOLUTION_SECONDS + GRACE_SECONDS + RETENTION_SECONDS + 1
    const store = new MemoryCounterStore(new MemorySqlStore(), () => millis(nowSeconds * 1_000))

    await store.record([
      {
        templateId: 'template-a',
        occurredAt: seconds(bucketStart + 1),
        placed: 2,
        correct: 1,
        repairs: 1,
      },
    ])

    await expect(store.readDroppedLateCount()).resolves.toBe(1)
    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: null,
      },
    ])
  })

  it('excludes retained flushed buckets from pending totals', async () => {
    const nowSeconds = 150
    const sql = new MemorySqlStore()
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: millis(150_000),
      },
    ])
  })

  it('subtracts a retained total from a failed late-arrival rewrite in readPending', async () => {
    let nowSeconds = 150
    let shouldReject = false
    const persisted = new MemorySqlStore()
    const sql: SqlStore = {
      async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
        if (shouldReject) throw new Error('D1 unavailable')
        await persisted.appendBuckets(buckets)
      },
      readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
        return persisted.readBuckets(query)
      },
    }
    const store = new MemoryCounterStore(sql, () => millis(nowSeconds * 1_000))

    await store.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await store.alarm()

    nowSeconds = 200
    await store.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 0 },
    ])
    shouldReject = true
    await expect(store.alarm()).rejects.toThrow('D1 unavailable')

    await expect(store.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 2,
        correct: 1,
        repairs: 0,
        flushedAt: millis(150_000),
      },
    ])
  })
})
