import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { seconds } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryBucket } from '../../ports/index.js'
import { D1SqlStore } from './d1-sql-store.js'

/**
 * Every migration in order, discovered rather than listed. drizzle-kit names files with a random
 * suffix, so hardcoding them breaks silently on regeneration — which is exactly what happened when
 * the migrations were squashed to a single baseline.
 */
const migrationsDir = join(import.meta.dirname, '../../../migrations')
const migration = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n')
  .replaceAll('--> statement-breakpoint', '')

/** `node:sqlite` declares this inside its module namespace without exporting it. */
type SupportedValueType = null | number | bigint | string | NodeJS.ArrayBufferView

const result = <T>(results: T[]): D1Result<T> =>
  ({ success: true, results, meta: {} }) as D1Result<T>

class SqliteD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly bindings: readonly SupportedValueType[] = [],
  ) {}

  bind(...values: SupportedValueType[]): SqliteD1Statement {
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

  it('issues no D1 calls when reading an empty template-id set', async () => {
    const callsBeforeRead = d1.prepareCalls

    await expect(
      store.readBuckets({
        templateIds: [],
        resolution: 60,
        fromSeconds: seconds(1_750_000_000),
        toSeconds: seconds(1_750_000_120),
      }),
    ).resolves.toEqual([])
    expect(d1.prepareCalls).toBe(callsBeforeRead)
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

  it('reads requested ids at one resolution over a half-open range in stable order', async () => {
    const fromSeconds = seconds(1_750_000_000)
    const middleSeconds = seconds(1_750_000_060)
    const toSeconds = seconds(1_750_000_120)
    const template1Start = bucket({ templateId: 'template-1', bucketStart: fromSeconds })
    const template1Middle = bucket({
      templateId: 'template-1',
      bucketStart: middleSeconds,
      placed: 11,
    })
    const template2Start = bucket({
      templateId: 'template-2',
      bucketStart: fromSeconds,
      placed: 12,
    })

    await store.appendBuckets([
      template2Start,
      bucket({ templateId: 'template-3', bucketStart: fromSeconds }),
      bucket({ templateId: 'template-1', resolution: 300, bucketStart: fromSeconds }),
      bucket({ templateId: 'template-1', bucketStart: toSeconds }),
      template1Middle,
      template1Start,
    ])

    await expect(
      store.readBuckets({
        templateIds: ['template-2', 'template-1'],
        resolution: 60,
        fromSeconds,
        toSeconds,
      }),
    ).resolves.toEqual([template1Start, template1Middle, template2Start])
  })

  it('enforces scope and resolution domains in SQL', () => {
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO access_tokens VALUES ('hash', 'label', 'superadmin', 'creator', 1, NULL)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite.prepare("INSERT INTO telemetry_buckets VALUES ('template', 42, 60, 1, 1, 0)").run(),
    ).toThrow()
    expect(() =>
      d1.sqlite.prepare("INSERT INTO tile_history VALUES (0, 0, 60, 0, 'hash', 1)").run(),
    ).toThrow()
  })

  it('requires native bounds to be complete, ordered and in latitude/longitude range', () => {
    d1.sqlite.exec(`
      INSERT INTO nodes VALUES ('node', NULL, '/node', 'Node', 1);
      INSERT INTO templates VALUES ('template', 'node', 'Template', 1, NULL, 1);
    `)

    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('partial', 'template', 1, 'creator', 0, 0, 1, 1, 1, 45, NULL, NULL, NULL)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('range', 'template', 1, 'creator', 0, 0, 1, 1, 1, 91, -45, -10, 10)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      d1.sqlite
        .prepare(
          "INSERT INTO template_versions VALUES ('ordered', 'template', 1, 'creator', 0, 0, 1, 1, 1, -45, 45, -10, 10)",
        )
        .run(),
    ).toThrow()
  })
})
