import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type Millis, millis, seconds } from '@wts/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1Database } from './adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryCounterStore } from './adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from './adapters/memory/memory-sql-store.js'
import {
  type CounterDelta,
  FLUSH_BATCH_LIMIT,
  RESOLUTION_SECONDS,
  type TelemetryBucket,
} from './ports/index.js'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class<Environment> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Environment

    constructor(ctx: DurableObjectState, env: Environment) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import { TelemetryShard } from './telemetry-shard.js'

type SqliteBinding = null | number | bigint | string | NodeJS.ArrayBufferView
type LocalRow = Record<string, SqlStorageValue>

class SqliteSqlStorageCursor<T extends LocalRow> implements Iterable<T> {
  readonly rowsRead: number
  readonly rowsWritten: number
  private position = 0

  constructor(
    private readonly rows: readonly T[],
    readonly columnNames: string[],
    rowsWritten = 0,
  ) {
    this.rowsRead = rows.length
    this.rowsWritten = rowsWritten
  }

  next(): IteratorResult<T> {
    const value = this.rows[this.position]
    if (value === undefined) return { done: true, value: undefined }
    this.position += 1
    return { done: false, value }
  }

  toArray(): T[] {
    return [...this.rows]
  }

  one(): T {
    if (this.rows.length !== 1) {
      throw new Error(`Expected exactly one SQL row, received ${this.rows.length}`)
    }
    return this.rows[0] as T
  }

  *raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    for (const row of this.rows) {
      yield this.columnNames.map((column) => row[column]) as U
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this
  }
}

class SqliteDurableObjectStorage {
  readonly sql: SqlStorage
  private alarmAt: number | null = null

  constructor(private readonly database: DatabaseSync) {
    this.sql = {
      exec: <T extends LocalRow>(query: string, ...bindings: SqliteBinding[]) =>
        this.exec<T>(query, bindings),
      get databaseSize() {
        return 0
      },
      Cursor: SqliteSqlStorageCursor as unknown as typeof SqlStorageCursor,
      Statement: class {} as unknown as typeof SqlStorageStatement,
    }
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }

  transactionSync<T>(closure: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = closure()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  outstandingRowCount(): number {
    const row = this.database
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM pending_counters) +
            (SELECT COUNT(*) FROM flush_batch) AS count
        `,
      )
      .get() as { count: number }
    return row.count
  }

  private exec<T extends LocalRow>(
    query: string,
    bindings: readonly SqliteBinding[],
  ): SqlStorageCursor<T> {
    const statements = query
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    if (statements.length > 1) {
      if (bindings.length > 0) throw new Error('Bound multi-statement SQL is unsupported in tests')
      this.database.exec(query)
      return new SqliteSqlStorageCursor<T>([], []) as unknown as SqlStorageCursor<T>
    }

    const statement = this.database.prepare(query)
    const columnNames = statement.columns().map(({ name }) => name)
    if (columnNames.length > 0) {
      const rows = statement.all(...bindings) as T[]
      return new SqliteSqlStorageCursor(rows, columnNames) as unknown as SqlStorageCursor<T>
    }

    const result = statement.run(...bindings)
    return new SqliteSqlStorageCursor<T>(
      [],
      [],
      Number(result.changes),
    ) as unknown as SqlStorageCursor<T>
  }
}

class SqliteDurableObjectState {
  private blocked: Promise<unknown> = Promise.resolve()

  constructor(readonly storage: SqliteDurableObjectStorage) {}

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const pending = callback()
    this.blocked = pending
    return pending
  }

  async ready(): Promise<void> {
    await this.blocked
  }
}

interface D1BucketRow {
  readonly template_id: string
  readonly resolution: number
  readonly bucket_start_s: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

class TelemetryShardHarness {
  readonly d1 = new SqliteD1Database()
  readonly storageDirectory = mkdtempSync(join(tmpdir(), 'wts-telemetry-shard-'))
  readonly storageDatabase = new DatabaseSync(join(this.storageDirectory, 'durable-object.sqlite'))
  readonly storage = new SqliteDurableObjectStorage(this.storageDatabase)
  readonly state = new SqliteDurableObjectState(this.storage)
  private readonly env = { DB: this.d1 as unknown as D1Database } as Env
  shard: TelemetryShard

  constructor(readonly clock: { now: Millis }) {
    this.shard = this.constructShard()
  }

  async ready(): Promise<void> {
    await this.state.ready()
  }

  async coldRestart(): Promise<void> {
    await this.ready()
    this.shard = this.constructShard()
    await this.ready()
  }

  nextAlarmAt(): Promise<number | null> {
    return this.storage.getAlarm()
  }

  d1Buckets(): TelemetryBucket[] {
    const rows = this.d1.sqlite
      .prepare(
        `
          SELECT template_id, resolution, bucket_start_s, placed, correct, repairs
          FROM telemetry_buckets
          ORDER BY template_id, bucket_start_s
        `,
      )
      .all() as unknown as D1BucketRow[]
    return rows.map((row) => ({
      templateId: row.template_id,
      resolution: row.resolution,
      bucketStart: seconds(row.bucket_start_s),
      placed: row.placed,
      correct: row.correct,
      repairs: row.repairs,
    }))
  }

  close(): void {
    this.storageDatabase.close()
    this.d1.close()
    rmSync(this.storageDirectory, { recursive: true })
  }

  private constructShard(): TelemetryShard {
    return new TelemetryShard(
      this.state as unknown as DurableObjectState,
      this.env,
      () => this.clock.now,
    )
  }
}

interface Totals {
  placed: number
  correct: number
  repairs: number
}

const zeroTotals = (): Totals => ({ placed: 0, correct: 0, repairs: 0 })

const addTotals = (total: Totals, value: Totals): void => {
  total.placed += value.placed
  total.correct += value.correct
  total.repairs += value.repairs
}

const sumBuckets = (buckets: readonly TelemetryBucket[]): Totals => {
  const total = zeroTotals()
  for (const bucket of buckets) addTotals(total, bucket)
  return total
}

const pseudoRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const generatedDelta = (random: () => number): CounterDelta => {
  const placed = 1 + Math.floor(random() * 8)
  const correct = Math.floor(random() * (placed + 1))
  return {
    templateId: `template-${Math.floor(random() * 5)}`,
    occurredAt: seconds(9_000 + Math.floor(random() * 15) * 60 + 1),
    placed,
    correct,
    repairs: Math.floor(random() * (correct + 1)),
  }
}

const liveHarnesses: TelemetryShardHarness[] = []

const makeHarness = async (clock: Millis | { now: Millis }): Promise<TelemetryShardHarness> => {
  const harness = new TelemetryShardHarness(typeof clock === 'number' ? { now: clock } : clock)
  liveHarnesses.push(harness)
  await harness.ready()
  return harness
}

afterEach(() => {
  for (const harness of liveHarnesses.splice(0)) harness.close()
})

describe('TelemetryShard', () => {
  it('stays observationally identical to MemoryCounterStore after every operation', async () => {
    const clock = { now: millis(10_000_000) }
    const shard = await makeHarness(clock)
    const memorySql = new MemorySqlStore()
    const memory = new MemoryCounterStore(memorySql, () => clock.now)
    const templateIds = ['template-a', 'template-b', 'missing']

    const assertParity = async (): Promise<void> => {
      expect(await shard.shard.readPending(templateIds)).toEqual(
        await memory.readPending(templateIds),
      )
      expect(await shard.shard.readDroppedLateCount()).toBe(await memory.readDroppedLateCount())
      expect(await shard.nextAlarmAt()).toBe(memory.nextAlarmAt())
      expect(shard.d1Buckets()).toEqual(
        await memorySql.readBuckets({
          templateIds,
          resolution: RESOLUTION_SECONDS,
          fromSeconds: seconds(0),
          toSeconds: seconds(20_000),
        }),
      )
    }

    await assertParity()
    const bucketStarts = Array.from({ length: 30 }, (_, index) => 8_160 + index * 60)
    const initial = ['template-b', 'template-a'].flatMap((templateId) =>
      bucketStarts.toReversed().map((bucketStart) => ({
        templateId,
        occurredAt: seconds(bucketStart + 1),
        placed: 1,
        correct: 1,
        repairs: 0,
      })),
    )
    await shard.shard.record(initial)
    await memory.record(initial)
    await assertParity()

    await shard.shard.alarm()
    await memory.alarm()
    await assertParity()

    await shard.shard.alarm()
    await memory.alarm()
    await assertParity()

    const lateAndInvalid: readonly CounterDelta[] = [
      {
        templateId: 'template-a',
        occurredAt: seconds(bucketStarts[0] as number),
        placed: 3,
        correct: 2,
        repairs: 1,
      },
      {
        templateId: 'template-b',
        occurredAt: seconds(20_000),
        placed: 1,
        correct: 1,
        repairs: 0,
      },
    ]
    await shard.shard.record(lateAndInvalid)
    await memory.record(lateAndInvalid)
    await assertParity()

    await shard.shard.alarm()
    await memory.alarm()
    await assertParity()

    clock.now = millis(20_000_000)
    const expired: readonly CounterDelta[] = [
      {
        templateId: 'template-a',
        occurredAt: seconds(bucketStarts[0] as number),
        placed: 1,
        correct: 0,
        repairs: 0,
      },
    ]
    await shard.shard.record(expired)
    await memory.record(expired)
    await assertParity()
  })

  it('keeps the batch pending until D1 has committed', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.d1.failNextBatchAt('before-commit')

    await harness.shard.alarm()

    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
    expect(harness.d1Buckets()).toEqual([])
  })

  it('measures retry backoff from the time D1 fails', async () => {
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)
    harness.d1.failNextBatchAt('before-commit', () => {
      harness.clock.now = millis(261_000)
    })

    await harness.shard.alarm()

    expect(await harness.nextAlarmAt()).toBe(262_000)
  })

  it('resolves rather than rethrowing when D1 fails, so the platform does not own the retry', async () => {
    // Cloudflare retries a throwing alarm() at most six times, starting at a 2s delay. Rethrowing
    // would therefore cap recovery at roughly two minutes of D1 outage and then strand flush_batch
    // until unrelated traffic re-armed the alarm. Owning the retry is why the backoff exists.
    // https://developers.cloudflare.com/durable-objects/api/alarms/
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)
    harness.d1.failNextBatchAt('before-commit', () => {})

    await expect(harness.shard.alarm()).resolves.toBeUndefined()

    // The work is still owed, and an alarm is scheduled to come back for it.
    expect(await harness.nextAlarmAt()).toBeGreaterThan(200_000)
    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
  })

  it('subtracts the retained total from a failed late-arrival rewrite', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.shard.alarm()

    harness.clock.now = millis(200_000)
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 0 },
    ])
    harness.d1.failNextBatchAt('before-commit')
    await harness.shard.alarm()

    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 2,
        correct: 1,
        repairs: 0,
        flushedAt: millis(150_000),
      },
    ])
  })

  it('flushes chunks in the same template-first order as the memory adapter', async () => {
    const harness = await makeHarness(millis(10_000_000))
    const bucketStarts = Array.from({ length: 30 }, (_, index) => 8_160 + index * 60)
    await harness.shard.record(
      ['template-b', 'template-a'].flatMap((templateId) =>
        bucketStarts.toReversed().map((bucketStart) => ({
          templateId,
          occurredAt: seconds(bucketStart + 1),
          placed: 1,
          correct: 1,
          repairs: 0,
        })),
      ),
    )

    await harness.shard.alarm()

    expect(
      harness.d1Buckets().map(({ templateId, bucketStart }) => ({ templateId, bucketStart })),
    ).toEqual([
      ...bucketStarts.map((bucketStart) => ({ templateId: 'template-a', bucketStart })),
      ...bucketStarts
        .slice(0, FLUSH_BATCH_LIMIT - bucketStarts.length)
        .map((bucketStart) => ({ templateId: 'template-b', bucketStart })),
    ])
  })

  it('preserves accepted totals through generated sequences and a full drain', async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const harness = await makeHarness(millis(10_000_000))
      const random = pseudoRandom(seed)
      const accepted = zeroTotals()
      const deltas = Array.from({ length: 75 }, () => generatedDelta(random))
      for (const delta of deltas) addTotals(accepted, delta)

      for (let offset = 0; offset < deltas.length; offset += 7) {
        await harness.shard.record(deltas.slice(offset, offset + 7))
      }
      for (let drain = 0; (await harness.nextAlarmAt()) !== null; drain += 1) {
        expect(drain).toBeLessThan(20)
        await harness.shard.alarm()
      }

      const pending = (
        await harness.shard.readPending([
          'template-0',
          'template-1',
          'template-2',
          'template-3',
          'template-4',
        ])
      ).reduce<Totals>((total, row) => {
        addTotals(total, row)
        return total
      }, zeroTotals())
      const historyAndPending = sumBuckets(harness.d1Buckets())
      addTotals(historyAndPending, pending)
      expect(historyAndPending, `seed ${seed}`).toEqual(accepted)
    }
  })

  it('never reports more history plus pending than generated accepted deltas', async () => {
    const templateIds = ['template-0', 'template-1', 'template-2', 'template-3', 'template-4']
    for (let seed = 101; seed <= 108; seed += 1) {
      const harness = await makeHarness(millis(10_000_000))
      const random = pseudoRandom(seed)
      const accepted = zeroTotals()

      for (let step = 0; step < 60; step += 1) {
        if (random() < 0.68) {
          const delta = generatedDelta(random)
          addTotals(accepted, delta)
          await harness.shard.record([delta])
        } else if ((await harness.nextAlarmAt()) !== null) {
          if (random() < 0.25) harness.d1.failNextBatchAt('before-commit')
          await harness.shard.alarm()
        }

        const observed = sumBuckets(harness.d1Buckets())
        for (const row of await harness.shard.readPending(templateIds)) addTotals(observed, row)
        expect(observed.placed, `placed seed ${seed}, step ${step}`).toBeLessThanOrEqual(
          accepted.placed,
        )
        expect(observed.correct, `correct seed ${seed}, step ${step}`).toBeLessThanOrEqual(
          accepted.correct,
        )
        expect(observed.repairs, `repairs seed ${seed}, step ${step}`).toBeLessThanOrEqual(
          accepted.repairs,
        )
      }
    }
  })

  it('always schedules an alarm while generated local rows remain outstanding', async () => {
    for (let seed = 201; seed <= 208; seed += 1) {
      const harness = await makeHarness(millis(10_000_000))
      const random = pseudoRandom(seed)

      for (let step = 0; step < 50; step += 1) {
        if (random() < 0.6) {
          await harness.shard.record([generatedDelta(random)])
        } else if ((await harness.nextAlarmAt()) !== null) {
          if (random() < 0.3) harness.d1.failNextBatchAt('before-commit')
          await harness.shard.alarm()
        } else {
          await harness.coldRestart()
        }

        if (harness.storage.outstandingRowCount() > 0) {
          expect(await harness.nextAlarmAt(), `seed ${seed}, step ${step}`).not.toBeNull()
        }
      }
    }
  })

  it.each([
    ['before D1 commit', 'before-commit'],
    ['after D1 commit but before local bookkeeping', 'after-commit'],
  ] as const)('recovers from a crash %s after a cold restart', async (_label, failurePoint) => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.d1.failNextBatchAt(failurePoint)
    await harness.shard.alarm()

    await harness.coldRestart()
    harness.clock.now = millis((await harness.nextAlarmAt()) as number)
    await harness.shard.alarm()

    expect(harness.d1Buckets()).toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: seconds(60),
        placed: 4,
        correct: 3,
        repairs: 1,
      },
    ])
    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: 0,
        correct: 0,
        repairs: 0,
        flushedAt: harness.clock.now,
      },
    ])
    expect(await harness.nextAlarmAt()).toBeNull()
  })
})
