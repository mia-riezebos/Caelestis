import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SqlConnection, SqlResult, SqlStatement } from '../sql-connection.js'

type Value = null | number | bigint | string | NodeJS.ArrayBufferView

const binding = (value: unknown): Value => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  )
    return value
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('Unsupported SQL binding')
}

class Statement implements SqlStatement {
  constructor(
    readonly owner: SqliteConnection,
    readonly query: string,
    readonly values: Value[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.owner, this.query, values.map(binding))
  }

  execute<T>(): SqlResult<T> {
    const statement = this.owner.sqlite.prepare(this.query)
    if (statement.columns().length > 0) {
      const results = statement.all(...this.values) as T[]
      return { results, meta: { changes: /\breturning\b/i.test(this.query) ? results.length : 0 } }
    }
    return { results: [], meta: { changes: Number(statement.run(...this.values).changes) } }
  }

  async run<T>(): Promise<SqlResult<T>> {
    return this.execute<T>()
  }
  async all<T>(): Promise<SqlResult<T>> {
    return this.execute<T>()
  }
  async first<T>(): Promise<T | null> {
    return this.execute<T>().results[0] ?? null
  }
  async raw<T>(): Promise<T[]> {
    const statement = this.owner.sqlite.prepare(this.query)
    statement.setReturnArrays(true)
    return statement.all(...this.values) as T[]
  }
}

/** Persistent SQLite connection. Synchronous batches cannot interleave across async requests. */
export class SqliteConnection implements SqlConnection {
  readonly sqlite: DatabaseSync

  constructor(filename: string) {
    this.sqlite = new DatabaseSync(filename)
    this.sqlite.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000',
    )
  }

  prepare(query: string): SqlStatement {
    return new Statement(this, query)
  }

  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement) || statement.owner !== this)
          throw new Error('Statement belongs to another connection')
        return statement.execute<T>()
      })
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  /** Apply immutable migrations once, recording their digest in the same transaction. */
  migrate(directory: string): void {
    this.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS caelestis_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
    )
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const source = readFileSync(join(directory, name), 'utf8')
      const digest = createHash('sha256').update(source).digest('hex')
      const previous = this.sqlite
        .prepare('SELECT sha256 FROM caelestis_migrations WHERE name = ?')
        .get(name)
      if (previous) {
        if (previous.sha256 !== digest)
          throw new Error(`Migration changed after application: ${name}`)
        continue
      }
      // Historic table-rebuild migrations require foreign keys disabled outside their transaction.
      this.sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
      try {
        this.sqlite.exec(source)
        if (this.sqlite.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error(`Foreign key violation after ${name}`)
        this.sqlite.prepare('INSERT INTO caelestis_migrations VALUES (?, ?)').run(name, digest)
        this.sqlite.exec('COMMIT')
      } catch (error) {
        this.sqlite.exec('ROLLBACK')
        throw error
      } finally {
        this.sqlite.exec('PRAGMA foreign_keys = ON')
      }
    }
  }

  close(): void {
    this.sqlite.close()
  }
}
