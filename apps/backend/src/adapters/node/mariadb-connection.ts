import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Connection,
  type ConnectionConfig,
  createConnection,
  type RowsWithMeta,
  type UpsertResult,
} from 'mariadb'
import type {
  SqlConnection,
  SqlResult,
  SqlStatement,
  TransactionalSqlConnection,
} from '../sql-connection.js'
import { mariaSql } from './mariadb-sql.js'

class Statement implements SqlStatement {
  constructor(
    readonly owner: MariaConnection,
    readonly query: string,
    readonly values: unknown[] = [],
    readonly client?: Connection,
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.owner, this.query, values, this.client)
  }
  private async execute(client: Connection) {
    const { query, parameters, guarded } = mariaSql(this.query, this.values)
    try {
      if (guarded) await client.query('SET @caelestis_upsert_allowed = NULL')
      const result = await client.query<RowsWithMeta<unknown[]> | UpsertResult>(
        { sql: query, rowsAsArray: true },
        parameters,
      )
      if (!Array.isArray(result)) return { rows: [], objects: [], changes: result.affectedRows }
      if (guarded) {
        const [guard] = await client.query<{ allowed: number | null }[]>(
          'SELECT @caelestis_upsert_allowed AS allowed',
        )
        if (guard?.allowed === 0) return { rows: [], objects: [], changes: 0 }
      }
      return {
        rows: result,
        objects: result.map((row) =>
          Object.fromEntries(result.meta.map((field, index) => [field.name(), row[index]])),
        ),
        changes: /^INSERT\b/i.test(query) ? result.length : 0,
      }
    } catch (cause) {
      throw new Error(`MariaDB query failed: ${query}`, { cause })
    }
  }
  private using<T>(operation: (client: Connection) => Promise<T>) {
    return this.client ? operation(this.client) : this.owner.withClient(operation)
  }
  run<T>(): Promise<SqlResult<T>> {
    return this.using(async (client) => {
      const result = await this.execute(client)
      return { results: result.objects as T[], meta: { changes: result.changes } }
    })
  }
  all<T>() {
    return this.run<T>()
  }
  async first<T>() {
    return (await this.run<T>()).results[0] ?? null
  }
  raw<T>(): Promise<T[]> {
    return this.using(async (client) => (await this.execute(client)).rows as T[])
  }
}

/** One non-reconnecting session owns the runtime, serializes transactions, and holds GET_LOCK. */
export class MariaConnection implements TransactionalSqlConnection {
  readonly dialect = 'mariadb'
  private client: Promise<Connection> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private failure: Error | undefined
  private closing = false
  private onLost: ((error: Error) => void) | undefined
  constructor(readonly config: ConnectionConfig) {}
  private connect() {
    this.client ??= createConnection({
      connectTimeout: 10_000,
      queryTimeout: 30_000,
      bigIntAsNumber: true,
      decimalAsNumber: true,
      checkNumberRange: true,
      foundRows: false,
      logParam: false,
      autoJsonMap: false,
      charset: 'utf8mb4',
      collation: 'utf8mb4_nopad_bin',
      ...this.config,
    }).then(async (client) => {
      client.on('error', (error: Error) => {
        this.failure ??= error
        if (!this.closing) this.onLost?.(error)
      })
      await client.query(
        "SET SESSION sql_mode = 'ANSI_QUOTES,PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO'",
      )
      return client
    })
    return this.client
  }
  withClient<T>(operation: (client: Connection) => Promise<T>): Promise<T> {
    const execute = async () => {
      if (this.closing) throw new Error('Database is closing')
      if (this.failure) throw this.failure
      return operation(await this.connect())
    }
    const running = this.tail.then(execute, execute)
    this.tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }
  async claimOwnership(onLost: (error: Error) => void) {
    if (this.onLost) throw new Error('Ownership already acquired')
    await this.withClient(async (client) => {
      const [row] = await client.query<{ acquired: number }[]>(
        "SELECT GET_LOCK(CONCAT('caelestis:', DATABASE()), 0) AS acquired",
      )
      if (row?.acquired !== 1) throw new Error('Another Caelestis server owns this database')
      this.onLost = onLost
    })
  }
  prepare(query: string): SqlStatement {
    return new Statement(this, query)
  }
  private async executeBatch<T>(client: Connection, statements: SqlStatement[]) {
    const results: SqlResult<T>[] = []
    for (const statement of statements) {
      if (!(statement instanceof Statement) || statement.owner !== this)
        throw new Error('Statement belongs to another connection')
      if (statement.query.includes('@caelestis_changed_rows'))
        await client.query('SET @caelestis_changed_rows = ?', [results.at(-1)?.meta.changes ?? 0])
      results.push(await new Statement(this, statement.query, statement.values, client).run<T>())
    }
    return results
  }
  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transaction((connection) => connection.batch<T>(statements))
      } catch (error) {
        let cause = error
        while (cause instanceof Error && cause.cause) cause = cause.cause
        if (
          attempt >= 5 ||
          !(cause instanceof Error) ||
          !('errno' in cause) ||
          ![1205, 1213].includes(Number(cause.errno))
        )
          throw error
      }
    }
  }
  transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      await client.beginTransaction()
      try {
        const result = await operation({
          dialect: this.dialect,
          prepare: (query) => new Statement(this, query, [], client),
          batch: <R>(statements: SqlStatement[]) => this.executeBatch<R>(client, statements),
        })
        await client.commit()
        return result
      } catch (error) {
        await client.rollback()
        throw error
      }
    })
  }
  /** MariaDB DDL commits implicitly. Interrupted migrations fail closed until the backup is restored. */
  async migrate(directory: string) {
    await this.withClient(async (client) => {
      const [lock] = await client.query<{ acquired: number }[]>(
        "SELECT GET_LOCK(CONCAT('caelestis-migrations:', DATABASE()), 30) AS acquired",
      )
      if (lock?.acquired !== 1) throw new Error('Could not acquire migration lock')
      try {
        await client.query(
          'CREATE TABLE IF NOT EXISTS caelestis_migrations (name VARCHAR(256) PRIMARY KEY, sha256 VARCHAR(64) NOT NULL, complete BOOLEAN NOT NULL)',
        )
        for (const name of (await readdir(directory))
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          const source = await readFile(join(directory, name), 'utf8')
          const digest = createHash('sha256').update(source).digest('hex')
          const [previous] = await client.query<{ sha256: string; complete: number }[]>(
            'SELECT sha256, complete FROM caelestis_migrations WHERE name = ?',
            [name],
          )
          if (previous) {
            if (previous.sha256 !== digest)
              throw new Error(`Migration changed after application: ${name}`)
            if (!previous.complete)
              throw new Error(
                `Interrupted MariaDB migration ${name}; restore the pre-migration backup before restarting`,
              )
            continue
          }
          await client.query('INSERT INTO caelestis_migrations VALUES (?, ?, false)', [
            name,
            digest,
          ])
          const statements: string[] = []
          let start = 0
          const sql = source.replace(
            /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
            (token) => (token.startsWith('--') || token.startsWith('/*') ? '' : token),
          )
          for (const token of sql.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"|;/g)) {
            if (token[0] !== ';') continue
            statements.push(sql.slice(start, token.index))
            start = token.index + 1
          }
          statements.push(sql.slice(start))
          for (const statement of statements.filter((query) => query.trim()))
            await client.query(statement)
          await client.query('UPDATE caelestis_migrations SET complete = true WHERE name = ?', [
            name,
          ])
        }
      } finally {
        await client.query("SELECT RELEASE_LOCK(CONCAT('caelestis-migrations:', DATABASE()))")
      }
    })
  }
  async close() {
    await this.tail
    this.closing = true
    if (this.client) await (await this.client).end()
  }
}
