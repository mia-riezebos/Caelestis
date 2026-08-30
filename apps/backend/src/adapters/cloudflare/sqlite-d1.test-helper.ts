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

const result = <T>(results: T[], changes = 0): D1Result<T> =>
  ({ success: true, results, meta: { changes } }) as D1Result<T>

/**
 * D1 caps a LIKE or GLOB pattern at 50 bytes, and `node:sqlite` uses SQLite's own default of 50,000
 * — so a prefix match over a node path, which may be 256 characters, ran happily here and answered
 * "LIKE or GLOB pattern too complex" in production. Modelled for the same reason `batchStatements`
 * is: the limit is real, it is not a limit this SQLite has, and nothing else in the suite can see it.
 *
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const MAX_LIKE_PATTERN_BYTES = 50

/**
 * The parameter indexes that are the pattern operand of a LIKE or GLOB, and the literal patterns.
 *
 * The cap applies to the pattern, not to the value being searched — `? LIKE 'x%'` with a long value
 * is fine by D1 and only the two-byte pattern counts. Matching on the operand rather than on every
 * binding keeps the fake from refusing queries D1 would run.
 *
 * A regex, not a parser: this reads statements drizzle generates, where the pattern is either a bound
 * `?` or a quoted literal directly after the operator.
 */
const PATTERN_OPERAND = /\b(?:like|glob)\s+(\?|'((?:[^']|'')*)')/gi

const patternBytes = (sql: string): { indexes: Set<number>; literals: number[] } => {
  const indexes = new Set<number>()
  const literals: number[] = []
  for (const match of sql.matchAll(PATTERN_OPERAND)) {
    if (match[1] === '?') {
      // Ordinal of this `?` among all of them, which is the binding it takes.
      indexes.add((sql.slice(0, match.index).match(/\?/g) ?? []).length)
    } else if (match[2] !== undefined) {
      literals.push(Buffer.byteLength(match[2].replaceAll("''", "'"), 'utf8'))
    }
  }
  return { indexes, literals }
}

class SqliteD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly sql: string,
    private readonly bindings: readonly SupportedValueType[] = [],
  ) {}

  bind(...values: SupportedValueType[]): SqliteD1Statement {
    return new SqliteD1Statement(this.statement, this.sql, values)
  }

  private refusePatternsD1WouldRefuse(): void {
    const { indexes, literals } = patternBytes(this.sql)
    const bound = [...indexes].map((index) => {
      const binding = this.bindings[index]
      return typeof binding === 'string' ? Buffer.byteLength(binding, 'utf8') : 0
    })
    if ([...bound, ...literals].some((bytes) => bytes > MAX_LIKE_PATTERN_BYTES)) {
      throw new Error('LIKE or GLOB pattern too complex')
    }
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.refusePatternsD1WouldRefuse()
    if (this.statement.columns().length > 0) {
      const rows = this.statement.all(...this.bindings) as T[]
      return result(rows, /\breturning\b/i.test(this.sql) ? rows.length : 0)
    }
    const changed = this.statement.run(...this.bindings)
    return result<T>([], Number(changed.changes))
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.refusePatternsD1WouldRefuse()
    return result(this.statement.all(...this.bindings) as T[])
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.refusePatternsD1WouldRefuse()
    return (this.statement.get(...this.bindings) as T | undefined) ?? null
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.refusePatternsD1WouldRefuse()
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
    return new SqliteD1Statement(this.sqlite.prepare(query), query)
  }

  failNextBatchAt(point: D1BatchFailurePoint, beforeBatch?: () => void): void {
    this.nextFailure = point
    this.beforeNextBatch = beforeBatch ?? null
  }

  /** Stage a concurrent write after an adapter's guard reads but before its next atomic batch. */
  runBeforeNextBatch(callback: () => void): void {
    this.beforeNextBatch = callback
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
