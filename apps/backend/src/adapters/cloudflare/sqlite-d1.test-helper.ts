import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/**
 * Every migration in order, discovered rather than listed. drizzle-kit names files with a random
 * suffix, so hardcoding them breaks silently on regeneration.
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

export type D1BatchFailurePoint = 'before-commit' | 'after-commit'

/** SQLite-backed D1 fake shared by the D1 adapter and Durable Object tests. */
export class SqliteD1Database {
  readonly sqlite = new DatabaseSync(':memory:')
  prepareCalls = 0
  batchCalls = 0
  /**
   * Statements across every batch, because D1's real limit is queries per Worker invocation and
   * `node:sqlite` has no such limit to trip over. Same reason `prepareCalls` exists: the count is
   * the only observable that distinguishes a batch D1 would run from one it would refuse.
   */
  batchStatements = 0
  private nextFailure: D1BatchFailurePoint | null = null
  private beforeNextBatch: (() => void) | null = null

  constructor() {
    this.sqlite.exec(migration)
  }

  prepare(query: string): SqliteD1Statement {
    this.prepareCalls += 1
    return new SqliteD1Statement(this.sqlite.prepare(query))
  }

  failNextBatchAt(point: D1BatchFailurePoint, beforeBatch?: () => void): void {
    this.nextFailure = point
    this.beforeNextBatch = beforeBatch ?? null
  }

  async batch<T = unknown>(statements: readonly SqliteD1Statement[]): Promise<D1Result<T>[]> {
    this.batchCalls += 1
    this.batchStatements += statements.length
    const failure = this.nextFailure
    const beforeBatch = this.beforeNextBatch
    this.nextFailure = null
    this.beforeNextBatch = null
    beforeBatch?.()

    if (failure === 'before-commit') throw new Error('D1 unavailable before commit')

    this.sqlite.exec('BEGIN')
    let results: D1Result<T>[]
    try {
      results = await Promise.all(statements.map((statement) => statement.run<T>()))
      this.sqlite.exec('COMMIT')
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }

    if (failure === 'after-commit') throw new Error('D1 response lost after commit')
    return results
  }

  close(): void {
    this.sqlite.close()
  }
}
