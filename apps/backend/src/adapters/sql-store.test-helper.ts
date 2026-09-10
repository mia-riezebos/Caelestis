import { join } from 'node:path'
import type { SqlStore } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'
import { PostgresConnection } from './node/postgres-connection.js'
import { SqliteConnection } from './node/sqlite-connection.js'
import { RelationalSqlStore } from './relational-sql-store.js'

export type SqlStoreHarness = { store: SqlStore; close(): void | Promise<void> }

/** The same behavioral assertions exercise every supported relational store. */
export const sqlStoreAdapters: {
  name: string
  make(): SqlStoreHarness | Promise<SqlStoreHarness>
}[] = [
  { name: 'memory', make: () => ({ store: new MemorySqlStore(), close() {} }) },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      const batch = database.batch.bind(database)
      let pending = Promise.resolve()
      database.batch = <T>(statements: Parameters<SqliteD1Database['batch']>[0]) => {
        const result = pending.then(() => batch<T>(statements))
        pending = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }
      return {
        store: new D1SqlStore(database as unknown as D1Database),
        close: () => database.close(),
      }
    },
  },
  {
    name: 'SQLite',
    make: () => {
      const database = new SqliteConnection(':memory:')
      database.migrate(join(import.meta.dirname, '../../migrations'))
      return { store: new RelationalSqlStore(database), close: () => database.close() }
    },
  },
]

if (process.env.CAELESTIS_TEST_POSTGRES_URL) {
  sqlStoreAdapters.push({
    name: 'PostgreSQL',
    async make() {
      const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
      const database = new PostgresConnection({
        connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
        options: `-c search_path=${schema}`,
      })
      await database.pool.query(`CREATE SCHEMA ${schema}`)
      try {
        await database.migrate(join(import.meta.dirname, '../../migrations-postgres'))
      } catch (error) {
        await database.pool.query(`DROP SCHEMA ${schema} CASCADE`)
        await database.close()
        throw error
      }
      return {
        store: new RelationalSqlStore(database),
        async close() {
          try {
            await database.pool.query(`DROP SCHEMA ${schema} CASCADE`)
          } finally {
            await database.close()
          }
        },
      }
    },
  })
}
