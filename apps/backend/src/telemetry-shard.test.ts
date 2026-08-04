import { AsyncLocalStorage } from 'node:async_hooks'
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
  EXPIRES_AFTER_SECONDS,
  FLUSH_BATCH_LIMIT,
  FLUSHABLE_AFTER_SECONDS,
  MAX_COUNTER_DELTAS_PER_RECORD,
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
  readonly rowsWritten: number
  private position = 0

  constructor(
    private readonly rows: readonly T[],
    readonly columnNames: string[],
    rowsWritten = 0,
  ) {
    this.rowsWritten = rowsWritten
  }

  get rowsRead(): number {
    return this.position
  }

  next(): IteratorResult<T> {
    const value = this.rows[this.position]
    if (value === undefined) return { done: true, value: undefined }
    this.position += 1
    return { done: false, value }
  }

  toArray(): T[] {
    return [...this]
  }

  one(): T {
    const remaining = this.rows.length - this.position
    if (remaining !== 1) {
      throw new Error(`Expected exactly one SQL row, received ${remaining}`)
    }
    return this.next().value as T
  }

  *raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    for (const row of this) {
      yield this.columnNames.map((column) => row[column]) as U
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this
  }
}

class SqliteDurableObjectStorage {
  private static readonly insideGate = new AsyncLocalStorage<symbol>()
  private transactionDepth = 0
  private gate: symbol | null = null
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
    this.assertUngated()
    return this.alarmAt
  }

  /**
   * The real runtime deletes the alarm *before* invoking the handler, so `getAlarm()` inside
   * `alarm()` returns null unless that invocation re-arms. Returning the stored timestamp instead
   * lets a missing re-arm pass here while production strands the remaining rows.
   */
  consumeAlarm(): void {
    this.alarmAt = null
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.assertUngated()
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime
  }

  async deleteAlarm(): Promise<void> {
    this.assertUngated()
    this.alarmAt = null
  }

  /**
   * The runtime nests these — an inner transactionSync rolls back to where it started without
   * discarding the outer one's work. A plain BEGIN/COMMIT fake throws on the inner call, so it
   * would reject code the runtime accepts. Savepoints past depth zero reproduce it.
   */
  transactionSync<T>(closure: () => T): T {
    this.assertUngated()
    const depth = this.transactionDepth
    const savepoint = `wts_txn_${depth}`
    this.database.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.transactionDepth = depth + 1
    // Restore the depth from the value captured on entry rather than decrementing. A decrement runs
    // twice if the closing statement itself throws, leaving the depth at -1 and every later call
    // emitting `SAVEPOINT wts_txn_-1`, which is a syntax error rather than a transaction.
    try {
      const result = closure()
      this.transactionDepth = depth
      this.database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (error) {
      this.transactionDepth = depth
      this.database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
      throw error
    }
  }

  /**
   * Run `callback` as the sole permitted user of this storage. Membership is tracked by async
   * context rather than a flag, so the callback's own continuations after an `await` still count as
   * inside while anything else does not.
   */
  async whileGated<T>(callback: () => Promise<T>): Promise<T> {
    const token = Symbol('block')
    this.gate = token
    try {
      return await SqliteDurableObjectStorage.insideGate.run(token, callback)
    } finally {
      if (this.gate === token) this.gate = null
    }
  }

  /** Run `body` outside any gate's async context, so a gated storage rejects it. */
  static outsideAnyGate<T>(body: () => T): T {
    return SqliteDurableObjectStorage.insideGate.exit(body)
  }

  private assertUngated(): void {
    if (this.gate !== null && SqliteDurableObjectStorage.insideGate.getStore() !== this.gate) {
      throw new Error(
        'storage touched during blockConcurrencyWhile; the runtime would have deferred it',
      )
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
    this.assertUngated()
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

  /**
   * The runtime defers every other request until the callback settles. A fake that merely runs the
   * callback is *permissive*: a test could reach the shard mid-migration and pass, where the real
   * runtime would never have delivered that call. Rather than half-model the deferral, the storage
   * is gated so any such call throws — a fake that is wrong in the strict direction fails loudly
   * instead of manufacturing confidence.
   */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const pending = this.storage.whileGated(callback)
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

  /**
   * Deliver an alarm the way the runtime does: consume it, then invoke the handler. Calling
   * `shard.alarm()` directly leaves the fired alarm in place, which hides a missing re-arm.
   */
  async deliverAlarm(): Promise<void> {
    this.storage.consumeAlarm()
    await this.shard.alarm()
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

/**
 * Fails the twin's writes in lockstep with the fake D1's, so the failure path is compared rather
 * than merely verified twice. `before-commit` loses the write; `after-commit` lands it and loses
 * only the acknowledgement, which is the mode that leaves the time series ahead of retained.
 */
class FailableMemorySqlStore extends MemorySqlStore {
  private failAt: 'before-commit' | 'after-commit' | null = null

  failNextBatchAt(failAt: 'before-commit' | 'after-commit'): void {
    this.failAt = failAt
  }

  override async appendBuckets(buckets: readonly TelemetryBucket[]): Promise<void> {
    const failAt = this.failAt
    this.failAt = null
    if (failAt === 'before-commit') throw new Error('memory twin: write rejected')
    await super.appendBuckets(buckets)
    if (failAt === 'after-commit') throw new Error('memory twin: acknowledgement lost')
  }
}

describe('the Durable Object fake', () => {
  // Every claim the shard tests make rests on this fake. If its transaction or concurrency
  // semantics are wrong, a green suite is evidence of nothing, so the substrate is tested directly.

  it('rolls the whole transaction back when the closure throws', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    const before = harness.storage.outstandingRowCount()

    expect(() =>
      harness.storage.transactionSync(() => {
        harness.storage.sql.exec('DELETE FROM pending_counters')
        throw new Error('abort')
      }),
    ).toThrow('abort')

    expect(harness.storage.outstandingRowCount()).toBe(before)
  })

  it('nests transactions, rolling the inner one back without discarding the outer', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])

    harness.storage.transactionSync(() => {
      harness.storage.sql.exec(
        `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
         VALUES ('outer', 60, 1, 1, 0)`,
      )
      expect(() =>
        harness.storage.transactionSync(() => {
          harness.storage.sql.exec(
            `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
             VALUES ('inner', 60, 1, 1, 0)`,
          )
          throw new Error('inner abort')
        }),
      ).toThrow('inner abort')
    })

    await expect(harness.shard.readPending(['outer', 'inner'])).resolves.toEqual([
      { templateId: 'outer', placed: 1, correct: 1, repairs: 0, flushedAt: null },
      { templateId: 'inner', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
  })

  it('keeps the work of a nested transaction that succeeds', async () => {
    // The nesting test above only covers the inner-throws path, so a fake whose RELEASE was really
    // a ROLLBACK TO — silently discarding every successful nested transaction — passed it.
    const harness = await makeHarness(millis(150_000))

    harness.storage.transactionSync(() => {
      harness.storage.transactionSync(() => {
        harness.storage.sql.exec(
          `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
           VALUES ('inner', 60, 1, 1, 0)`,
        )
      })
      harness.storage.sql.exec(
        `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
         VALUES ('outer', 60, 2, 2, 0)`,
      )
    })

    await expect(harness.shard.readPending(['inner', 'outer'])).resolves.toEqual([
      { templateId: 'inner', placed: 1, correct: 1, repairs: 0, flushedAt: null },
      { templateId: 'outer', placed: 2, correct: 2, repairs: 0, flushedAt: null },
    ])
  })

  it('unwinds three deep, rolling back only the innermost', async () => {
    const harness = await makeHarness(millis(150_000))
    const insert = (templateId: string): void => {
      harness.storage.sql.exec(
        `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
         VALUES (?1, 60, 1, 1, 0)`,
        templateId,
      )
    }

    harness.storage.transactionSync(() => {
      insert('depth-0')
      harness.storage.transactionSync(() => {
        insert('depth-1')
        expect(() =>
          harness.storage.transactionSync(() => {
            insert('depth-2')
            throw new Error('deepest abort')
          }),
        ).toThrow('deepest abort')
      })
    })

    await expect(harness.shard.readPending(['depth-0', 'depth-1', 'depth-2'])).resolves.toEqual([
      { templateId: 'depth-0', placed: 1, correct: 1, repairs: 0, flushedAt: null },
      { templateId: 'depth-1', placed: 1, correct: 1, repairs: 0, flushedAt: null },
      { templateId: 'depth-2', placed: 0, correct: 0, repairs: 0, flushedAt: null },
    ])
  })

  it('leaves the nesting depth usable when a closing statement throws', async () => {
    // A depth left negative makes every later transactionSync emit `SAVEPOINT wts_txn_-1`, so the
    // whole fake stops working several tests after the one that broke it.
    const harness = await makeHarness(millis(150_000))
    const original = harness.storageDatabase.exec.bind(harness.storageDatabase)
    const failing = vi
      .spyOn(harness.storageDatabase, 'exec')
      .mockImplementation((sql: string, ...rest: unknown[]) => {
        if (sql === 'COMMIT') throw new Error('commit rejected')
        return (original as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest)
      })

    expect(() => harness.storage.transactionSync(() => undefined)).toThrow('commit rejected')
    failing.mockRestore()

    // Still a working transaction rather than a syntax error.
    harness.storage.transactionSync(() => {
      harness.storage.sql.exec(
        `INSERT INTO pending_counters (template_id, bucket_start_s, placed, correct, repairs)
         VALUES ('after', 60, 1, 1, 0)`,
      )
    })
    await expect(harness.shard.readPending(['after'])).resolves.toEqual([
      { templateId: 'after', placed: 1, correct: 1, repairs: 0, flushedAt: null },
    ])
  })

  it('refuses storage access while blockConcurrencyWhile is outstanding', async () => {
    // The runtime defers such a call rather than rejecting it, but a fake that simply allowed it
    // would let a test observe a half-migrated shard and call that a pass.
    const harness = await makeHarness(millis(150_000))
    let observed: unknown = null

    await harness.state.blockConcurrencyWhile(async () => {
      // Inside the callback's own async context the storage is reachable, before and after an await.
      harness.storage.sql.exec('SELECT 1')
      await Promise.resolve()
      harness.storage.sql.exec('SELECT 1')
      // Anything outside it is not.
      observed = await Promise.resolve().then(() =>
        SqliteDurableObjectStorage.outsideAnyGate(() => {
          try {
            harness.storage.sql.exec('SELECT 1')
            return 'permitted'
          } catch (error) {
            return (error as Error).message
          }
        }),
      )
    })

    expect(observed).toMatch(/the runtime would have deferred it/)
    harness.storage.sql.exec('SELECT 1')
  })
})

describe('TelemetryShard', () => {
  it('stays observationally identical to MemoryCounterStore after every operation', async () => {
    const clock = { now: millis(10_000_000) }
    const shard = await makeHarness(clock)
    const memorySql = new FailableMemorySqlStore()
    const memory = new MemoryCounterStore(memorySql, () => clock.now)
    const templateIds = ['template-a', 'template-b', 'missing']

    const assertParity = async (): Promise<void> => {
      expect(await shard.shard.readPending(templateIds)).toEqual(
        await memory.readPending(templateIds),
      )
      expect(await shard.shard.readDroppedLateCount()).toBe(await memory.readDroppedLateCount())
      expect(await shard.shard.readFlushFailureCount()).toBe(await memory.readFlushFailureCount())
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

    await shard.deliverAlarm()
    await memory.alarm()
    await assertParity()

    await shard.deliverAlarm()
    await memory.alarm()
    await assertParity()

    // Both failure modes, driven through both implementations at once. Verified separately these
    // only prove each side is self-consistent; driven together they prove the backoffs, the retained
    // rows and the failure counters have not drifted apart.
    //
    // Each iteration must record fresh flushable activity first. The alarms above drained
    // everything, and an alarm with nothing to flush returns before it ever reaches appendBuckets —
    // so arming a failure against an empty shard arms it for whichever later alarm happens to have
    // work, which is how the first version of this loop injected nothing at all. The failure-count
    // assertion below is what makes that impossible to reintroduce silently.
    let expectedFailures = 0
    for (const [index, failAt] of (['before-commit', 'after-commit'] as const).entries()) {
      const fresh = [
        {
          templateId: 'template-a',
          occurredAt: seconds(8_100 - index * 60),
          placed: 2,
          correct: 1,
          repairs: 1,
        },
      ]
      await shard.shard.record(fresh)
      await memory.record(fresh)
      await assertParity()

      shard.d1.failNextBatchAt(failAt)
      memorySql.failNextBatchAt(failAt)
      await shard.deliverAlarm()
      await memory.alarm()

      expectedFailures += 1
      expect(await shard.shard.readFlushFailureCount()).toBe(expectedFailures)
      await assertParity()

      // Recover, so the next iteration starts from a healed shard rather than compounding backoff.
      shard.clock.now = millis(shard.clock.now + 120_000)
      clock.now = shard.clock.now
      await shard.deliverAlarm()
      await memory.alarm()
      expectedFailures = 0
      expect(await shard.shard.readFlushFailureCount()).toBe(0)
      await assertParity()
    }

    await shard.deliverAlarm()
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

    await shard.deliverAlarm()
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
  }, 30_000)

  it('schedules the alarm for when the next bucket becomes flushable, not for now', async () => {
    // Every other test freezes the clock at or past the flushable instant, so Math.max(now, ...)
    // collapses to `now` and the arithmetic never matters. Here the clock sits well before it, so a
    // dropped grace window, a dropped flushability check, or a seconds value branded as millis all
    // produce a visibly wrong deadline. Getting this wrong re-arms for "now" while nothing is
    // flushable, and the next alarm promotes nothing and re-arms again — an unbounded hot loop.
    const occurredAt = seconds(9_000)
    const harness = await makeHarness(millis(9_010_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt, placed: 4, correct: 3, repairs: 1 },
    ])

    const bucketStart = Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS
    expect(await harness.nextAlarmAt()).toBe((bucketStart + FLUSHABLE_AFTER_SECONDS) * 1_000)
  })

  it('does not promote or re-arm for now while the bucket is still inside its grace window', async () => {
    const harness = await makeHarness(millis(9_010_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(9_000), placed: 4, correct: 3, repairs: 1 },
    ])

    await harness.deliverAlarm()

    // Nothing is flushable yet, so D1 stays empty and the next alarm is still the future deadline.
    expect(harness.d1Buckets()).toEqual([])
    expect(await harness.nextAlarmAt()).toBeGreaterThan(9_010_000)
  })

  it('keeps the batch pending until D1 has committed', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.d1.failNextBatchAt('before-commit')

    await harness.deliverAlarm()

    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
    expect(harness.d1Buckets()).toEqual([])
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('telemetry flush failed (attempt 1)'),
      expect.any(Error),
    )
    errorLog.mockRestore()
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

    await harness.deliverAlarm()

    expect(await harness.nextAlarmAt()).toBe(262_000)
  })

  it('backs off every consecutive shard failure and caps retries at 60 seconds', async () => {
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)

    for (const expectedDelay of [1, 2, 4, 8, 16, 32, 60, 60]) {
      harness.d1.failNextBatchAt('before-commit')
      await harness.deliverAlarm()
      expect(await harness.nextAlarmAt()).toBe(harness.clock.now + expectedDelay * 1_000)
      harness.clock.now = millis((await harness.nextAlarmAt()) as number)
    }
  })

  it('readPending re-arms a consumed alarm while a failed batch remains', async () => {
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()
    harness.storage.consumeAlarm()
    expect(await harness.nextAlarmAt()).toBeNull()

    await harness.shard.readPending(['template-a'])

    expect(await harness.nextAlarmAt()).toBe(200_000)
  })

  it('cold construction re-arms a consumed alarm while a failed batch remains', async () => {
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()
    harness.storage.consumeAlarm()

    await harness.coldRestart()

    expect(await harness.nextAlarmAt()).toBe(200_000)
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

    await expect(harness.deliverAlarm()).resolves.toBeUndefined()

    // The work is still owed, and an alarm is scheduled to come back for it.
    expect(await harness.nextAlarmAt()).toBeGreaterThan(200_000)
    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 4, correct: 3, repairs: 1, flushedAt: null },
    ])
  })

  it('absorbs a rewrite an hour after the bucket and drops one past the retention window', async () => {
    // The literals are the point. RETENTION_SECONDS is a contract value — every implementation has
    // to retain activity for the same span or a client's late report is absorbed by one and dropped
    // by another. Expressed in derived constants this test would follow the constant anywhere,
    // including to a value nobody chose, so the window is stated in absolute seconds here.
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.deliverAlarm()

    // Bucket 60, retained for an hour past the 90s grace window: expiry is 60 + 90 + 3600 = 3750.
    harness.clock.now = millis(3_700_000)
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 0 },
    ])
    await expect(harness.shard.readDroppedLateCount()).resolves.toBe(0)
    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 2, correct: 1, repairs: 0, flushedAt: 150_000 },
    ])

    await harness.deliverAlarm()
    harness.clock.now = millis(3_800_000)
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 1, correct: 1, repairs: 0 },
    ])

    await expect(harness.shard.readDroppedLateCount()).resolves.toBe(1)
  })

  it('subtracts the retained total from a failed late-arrival rewrite', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.deliverAlarm()

    harness.clock.now = millis(200_000)
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 0 },
    ])
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()

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

  it('keeps a retained row alive past its expiry while an unflushed batch still references it', async () => {
    // retained_counters is what stops a late rewrite being counted twice: readPending reports
    // batch - retained, because D1 already holds the retained portion. Prune it while the batch is
    // still stalled and the subtraction loses its subtrahend, so live totals read history + the
    // whole batch. Reachable during any D1 outage that outlasts RETENTION_SECONDS.
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.deliverAlarm()

    harness.clock.now = millis(200_000)
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 2, correct: 1, repairs: 0 },
    ])
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()

    // Push the clock well past the bucket's expiry with the batch still owed, so the prune runs
    // against a row that flush_batch is the only remaining reference to.
    const bucketStart = 60
    harness.clock.now = millis((bucketStart + EXPIRES_AFTER_SECONDS + 600) * 1_000)
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()

    // 4 in D1 plus 2 still pending is the 6 that was accepted. Losing the retained row reads 10.
    expect(sumBuckets(harness.d1Buckets())).toEqual({ placed: 4, correct: 3, repairs: 1 })
    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      { templateId: 'template-a', placed: 2, correct: 1, repairs: 0, flushedAt: 150_000 },
    ])
  })

  it('prunes an expired retained row once no local state references it', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.deliverAlarm()
    expect(
      harness.storageDatabase.prepare('SELECT COUNT(*) AS count FROM retained_counters').get(),
    ).toEqual({ count: 1 })

    harness.clock.now = millis(4_000_000)
    await harness.shard.record([
      { templateId: 'template-b', occurredAt: seconds(4_000), placed: 1, correct: 1, repairs: 0 },
    ])

    expect(
      harness.storageDatabase.prepare('SELECT COUNT(*) AS count FROM retained_counters').get(),
    ).toEqual({ count: 0 })
  })

  it('keeps a retained row alive past its expiry while pending activity still references it', async () => {
    // The sibling of the flush_batch guard, and the more dangerous one. The promotion join writes
    // pending + retained, and D1 replaces rather than adds — so if retained is pruned out from under
    // a pending late rewrite, the flush writes only the late portion over the larger value D1
    // already holds. That undercount is silent, permanent, and never heals.
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    await harness.deliverAlarm()

    // Stall a *different* template in flush_batch, so the flush_batch guard cannot be what keeps
    // template-a's retained row alive. Promotion only runs against an empty batch, so template-a's
    // late rewrite stays in pending_counters for the whole outage.
    harness.clock.now = millis(400_000)
    await harness.shard.record([
      { templateId: 'template-b', occurredAt: seconds(190), placed: 3, correct: 2, repairs: 0 },
    ])
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(110), placed: 6, correct: 4, repairs: 1 },
    ])

    // Outlast bucket 60's expiry at 3750s with the batch still owed, so the prune runs against a
    // retained row that only pending_counters still references.
    harness.clock.now = millis(4_000_000)
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()

    // D1 recovers: the stalled batch drains, then the next alarm promotes the late rewrite.
    await harness.deliverAlarm()
    await harness.deliverAlarm()

    expect(harness.d1Buckets()).toEqual([
      {
        templateId: 'template-a',
        resolution: RESOLUTION_SECONDS,
        bucketStart: 60,
        placed: 10,
        correct: 7,
        repairs: 2,
      },
      {
        templateId: 'template-b',
        resolution: RESOLUTION_SECONDS,
        bucketStart: 180,
        placed: 3,
        correct: 2,
        repairs: 0,
      },
    ])
    await expect(harness.shard.readPending(['template-a', 'template-b'])).resolves.toEqual([
      { templateId: 'template-a', placed: 0, correct: 0, repairs: 0, flushedAt: 4_000_000 },
      { templateId: 'template-b', placed: 0, correct: 0, repairs: 0, flushedAt: 4_000_000 },
    ])
  })

  it('drops deltas past MAX_COUNTER_DELTAS_PER_RECORD rather than writing them', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record(
      Array.from({ length: MAX_COUNTER_DELTAS_PER_RECORD + 5 }, () => ({
        templateId: 'template-a',
        occurredAt: seconds(100),
        placed: 1,
        correct: 1,
        repairs: 0,
      })),
    )

    await expect(harness.shard.readPending(['template-a'])).resolves.toEqual([
      {
        templateId: 'template-a',
        placed: MAX_COUNTER_DELTAS_PER_RECORD,
        correct: MAX_COUNTER_DELTAS_PER_RECORD,
        repairs: 0,
        flushedAt: null,
      },
    ])
    await expect(harness.shard.readDroppedLateCount()).resolves.toBe(5)
  })

  it('reads a template group larger than one SQLite parameter batch', async () => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-777', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    const templateIds = Array.from({ length: 1_200 }, (_, index) => `template-${index}`)

    const result = await harness.shard.readPending(templateIds)

    expect(result).toHaveLength(1_200)
    expect(result[777]).toEqual({
      templateId: 'template-777',
      placed: 4,
      correct: 3,
      repairs: 1,
      flushedAt: null,
    })
    expect(result[1_199]).toEqual({
      templateId: 'template-1199',
      placed: 0,
      correct: 0,
      repairs: 0,
      flushedAt: null,
    })
  })

  it('does not pull a pending retry forward when unrelated traffic arrives during an outage', async () => {
    // scheduleNextAlarm runs on every record and every readPending. If it overwrote a future
    // backoff deadline with `now`, a read during a D1 outage would collapse the backoff into an
    // alarm loop that hammers the failing D1 once per request.
    const harness = await makeHarness(millis(100_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.clock.now = millis(200_000)
    harness.d1.failNextBatchAt('before-commit')
    await harness.deliverAlarm()
    const backoffAt = await harness.nextAlarmAt()
    expect(backoffAt).toBeGreaterThan(200_000)

    await harness.shard.readPending(['template-a'])
    await harness.shard.record([
      { templateId: 'template-b', occurredAt: seconds(200), placed: 1, correct: 1, repairs: 0 },
    ])

    expect(await harness.nextAlarmAt()).toBe(backoffAt)
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

    await harness.deliverAlarm()

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
        await harness.deliverAlarm()
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
  }, 30_000)

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
          await harness.deliverAlarm()
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
  }, 30_000)

  it('always schedules an alarm while generated local rows remain outstanding', async () => {
    for (let seed = 201; seed <= 208; seed += 1) {
      const harness = await makeHarness(millis(10_000_000))
      const random = pseudoRandom(seed)

      for (let step = 0; step < 50; step += 1) {
        if (random() < 0.6) {
          await harness.shard.record([generatedDelta(random)])
        } else if ((await harness.nextAlarmAt()) !== null) {
          if (random() < 0.3) harness.d1.failNextBatchAt('before-commit')
          await harness.deliverAlarm()
        } else {
          await harness.coldRestart()
        }

        if (harness.storage.outstandingRowCount() > 0) {
          expect(await harness.nextAlarmAt(), `seed ${seed}, step ${step}`).not.toBeNull()
        }
      }
    }
  }, 30_000)

  it.each([
    ['before D1 commit', 'before-commit'],
    ['after D1 commit but before local bookkeeping', 'after-commit'],
  ] as const)('recovers from a crash %s after a cold restart', async (_label, failurePoint) => {
    const harness = await makeHarness(millis(150_000))
    await harness.shard.record([
      { templateId: 'template-a', occurredAt: seconds(100), placed: 4, correct: 3, repairs: 1 },
    ])
    harness.d1.failNextBatchAt(failurePoint)
    await harness.deliverAlarm()

    await harness.coldRestart()
    harness.clock.now = millis((await harness.nextAlarmAt()) as number)
    await harness.deliverAlarm()

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
