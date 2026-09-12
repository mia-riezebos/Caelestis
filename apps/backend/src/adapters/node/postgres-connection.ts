import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient, type PoolConfig, types } from 'pg'
import type {
  SqlConnection,
  SqlResult,
  SqlStatement,
  TransactionalSqlConnection,
} from '../sql-connection.js'

/** Translate parameter markers while preserving quoted strings and identifiers verbatim. */
export const postgresParameters = (query: string): string => {
  let ordinal = 0
  return query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?\d*/g, (token) => {
    if (!token.startsWith('?')) return token
    const index = token.length === 1 ? ordinal + 1 : Number(token.slice(1))
    ordinal = Math.max(ordinal, index)
    return `$${index}`
  })
}

const integer = (value: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database integer exceeds the wire range')
  return number
}

const TRANSACTION_ATTEMPTS = 5
const retryable = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if ('code' in error && (error.code === '40001' || error.code === '40P01')) return true
  return error.cause === undefined ? false : retryable(error.cause)
}

class Statement implements SqlStatement {
  constructor(
    readonly owner: PostgresConnection,
    readonly query: string,
    readonly values: unknown[] = [],
    readonly client?: PoolClient,
  ) {}
  bind(...values: unknown[]): Statement {
    return new Statement(this.owner, this.query, values, this.client)
  }

  async execute(client: PoolClient) {
    const text = postgresParameters(this.query)
    try {
      return await client.query<unknown[]>({ text, values: this.values, rowMode: 'array' })
    } catch (cause) {
      throw new Error(`PostgreSQL query failed: ${text}`, { cause })
    }
  }

  async run<T>(): Promise<SqlResult<T>> {
    const run = async (client: PoolClient): Promise<SqlResult<T>> => {
      const result = await this.execute(client)
      return {
        results: result.rows.map((row) =>
          Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
        ) as T[],
        meta: {
          changes: ['INSERT', 'UPDATE', 'DELETE'].includes(result.command)
            ? (result.rowCount ?? 0)
            : 0,
        },
      }
    }
    return this.client ? run(this.client) : this.owner.withClient(run)
  }
  all<T>(): Promise<SqlResult<T>> {
    return this.run<T>()
  }
  async first<T>(): Promise<T | null> {
    return (await this.run<T>()).results[0] ?? null
  }
  async raw<T>(): Promise<T[]> {
    const run = async (client: PoolClient) => (await this.execute(client)).rows as T[]
    return this.client ? run(this.client) : this.owner.withClient(run)
  }
}

/** PostgreSQL/CNPG uses primary connections and one checked-out client per atomic batch. */
export class PostgresConnection implements TransactionalSqlConnection {
  readonly dialect = 'postgres'
  readonly pool: Pool
  private owner: PoolClient | undefined
  private ownerFailure: Error | undefined
  private ownerTail: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      ...config,
      types: {
        getTypeParser(oid, format) {
          if (format !== 'binary' && (oid === 20 || oid === 1700)) return integer
          return types.getTypeParser(oid, format)
        },
      },
    })
  }

  /** Hold the ownership lock on the same connection used for every application query. */
  async claimOwnership(onLost: (error: Error) => void): Promise<void> {
    if (this.owner) throw new Error('Ownership already acquired')
    const client = await this.pool.connect()
    const lost = (error: Error) => {
      this.ownerFailure ??= error
      if (!this.closing) onLost(error)
    }
    client.on('error', lost)
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('caelestis-runtime'), hashtext(current_schema())) AS acquired",
      )
      if (!lock.rows[0]?.acquired) throw new Error('Another Caelestis server owns this database')
      this.owner = client
    } catch (error) {
      client.release(true)
      throw error
    }
  }

  /** Owned deployments never reconnect behind a lost ownership lock. */
  async withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const owner = this.owner
    if (owner) {
      const execute = () => {
        if (this.closing) throw new Error('Database is closing')
        if (this.ownerFailure) throw this.ownerFailure
        return operation(owner)
      }
      const running = this.ownerTail.then(execute, execute)
      this.ownerTail = running.then(
        () => undefined,
        () => undefined,
      )
      return running
    }
    const client = await this.pool.connect()
    try {
      return await operation(client)
    } finally {
      client.release()
    }
  }

  prepare(query: string): SqlStatement {
    return new Statement(this, query)
  }

  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.commitBatch<T>(statements)
      } catch (error) {
        if (attempt === TRANSACTION_ATTEMPTS || !retryable(error)) throw error
      }
    }
  }

  private async executeBatch<T>(
    client: PoolClient,
    statements: SqlStatement[],
  ): Promise<SqlResult<T>[]> {
    const results: SqlResult<T>[] = []
    for (const statement of statements) {
      if (!(statement instanceof Statement) || statement.owner !== this)
        throw new Error('Statement belongs to another connection')
      if (statement.query.includes("current_setting('caelestis.changed_rows')")) {
        await client.query("SELECT set_config('caelestis.changed_rows', $1, true)", [
          String(results.at(-1)?.meta.changes ?? 0),
        ])
      }
      results.push(await new Statement(this, statement.query, statement.values, client).run<T>())
    }
    return results
  }

  private commitBatch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.transaction((connection) => connection.batch<T>(statements))
  }

  async transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      try {
        const result = await operation({
          dialect: 'postgres',
          prepare: (query) => new Statement(this, query, [], client),
          batch: <R>(statements: SqlStatement[]) => this.executeBatch<R>(client, statements),
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  /** Serialize migration jobs and verify immutable SQL before applying pending migrations. */
  async migrate(directory: string): Promise<void> {
    await this.withClient(async (client) => {
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('caelestis-migrations'))")
        await client.query(
          'CREATE TABLE IF NOT EXISTS caelestis_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
        )
        for (const name of (await readdir(directory))
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          const source = await readFile(join(directory, name), 'utf8')
          const digest = createHash('sha256').update(source).digest('hex')
          const previous = await client.query<{ sha256: string }>(
            'SELECT sha256 FROM caelestis_migrations WHERE name = $1',
            [name],
          )
          if (previous.rows[0]) {
            if (previous.rows[0].sha256 !== digest)
              throw new Error(`Migration changed after application: ${name}`)
            continue
          }
          await client.query(source)
          await client.query('INSERT INTO caelestis_migrations VALUES ($1, $2)', [name, digest])
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  async close(): Promise<void> {
    this.closing = true
    await this.ownerTail
    this.owner?.release(true)
    await this.pool.end()
  }
}
