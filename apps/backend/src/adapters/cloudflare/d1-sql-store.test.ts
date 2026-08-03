import { readFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { seconds } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryBucket } from '../../ports/index.js'
import { D1SqlStore } from './d1-sql-store.js'

const migration = readFileSync(
  new URL('../../../migrations/0000_cool_pretty_boy.sql', import.meta.url),
  'utf8',
)

const result = <T>(results: T[]): D1Result<T> =>
  ({ success: true, results, meta: {} }) as D1Result<T>

class SqliteD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly bindings: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.statement, values)
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.statement.run(...this.bindings)
    return result<T>([])
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return result(this.statement.all(...this.bindings) as T[])
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.statement.setReturnArrays(true)
    return this.statement.all(...this.bindings) as T[]
  }
}

class SqliteD1Database {
  readonly sqlite = new DatabaseSync(':memory:')
  prepareCalls = 0
  batchCalls = 0

  constructor() {
    this.sqlite.exec(migration)
  }

  prepare(query: string): SqliteD1Statement {
    this.prepareCalls += 1
    return new SqliteD1Statement(this.sqlite.prepare(query))
  }

  async batch<T = unknown>(statements: readonly SqliteD1Statement[]): Promise<D1Result<T>[]> {
    this.batchCalls += 1
    this.sqlite.exec('BEGIN')
    try {
      const results = await Promise.all(statements.map((statement) => statement.run<T>()))
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.sqlite.close()
  }
}

const bucket = (overrides: Partial<TelemetryBucket> = {}): TelemetryBucket => ({
  templateId: 'template-1',
  resolution: 60,
  bucketStart: seconds(1_750_000_000),
  placed: 10,
  correct: 8,
  repairs: 2,
  ...overrides,
})

describe('D1SqlStore', () => {
  let d1: SqliteD1Database
  let store: D1SqlStore

  beforeEach(() => {
    d1 = new SqliteD1Database()
    store = new D1SqlStore(d1 as unknown as D1Database)
  })

  afterEach(() => d1.close())

  it('issues no D1 calls for empty input', async () => {
    await store.appendBuckets([])
    expect({ prepares: d1.prepareCalls, batches: d1.batchCalls }).toEqual({
      prepares: 0,
      batches: 0,
    })
  })

  it('replaces an identical retry instead of double-counting', async () => {
    await store.appendBuckets([bucket()])
    await store.appendBuckets([bucket()])

    expect(
      d1.sqlite.prepare('SELECT placed, correct, repairs FROM telemetry_buckets').get(),
    ).toEqual({
      placed: 10,
      correct: 8,
      repairs: 2,
    })
  })

  it('rewrites cumulative values in place', async () => {
    await store.appendBuckets([bucket()])
    await store.appendBuckets([bucket({ placed: 15, correct: 12, repairs: 4 })])

    expect(
      d1.sqlite.prepare('SELECT placed, correct, repairs FROM telemetry_buckets').get(),
    ).toEqual({
      placed: 15,
      correct: 12,
      repairs: 4,
    })
  })

  it('keeps distinct resolutions in separate rows', async () => {
    await store.appendBuckets([bucket(), bucket({ resolution: 300, placed: 20 })])

    expect(
      d1.sqlite
        .prepare('SELECT resolution, placed FROM telemetry_buckets ORDER BY resolution')
        .all(),
    ).toEqual([
      { resolution: 60, placed: 10 },
      { resolution: 300, placed: 20 },
    ])
  })

  it('writes a multi-row append with one batch call', async () => {
    await store.appendBuckets([
      bucket(),
      bucket({ templateId: 'template-2', bucketStart: seconds(1_750_000_060) }),
    ])

    expect(d1.batchCalls).toBe(1)
    expect(d1.sqlite.prepare('SELECT COUNT(*) AS count FROM telemetry_buckets').get()).toEqual({
      count: 2,
    })
  })
})
