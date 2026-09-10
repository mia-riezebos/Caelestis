import { join } from 'node:path'
import type { SqlStore } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'
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
