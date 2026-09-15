import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteConnection } from '../../src/adapters/node/sqlite-connection.js'
import { RelationalSqlStore } from '../../src/adapters/relational-sql-store.js'

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

export const openRelationalStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-backend-test-'))
  const connection = new SqliteConnection(join(directory, 'backend.sqlite'))
  connection.migrate(migrationDirectory)
  return {
    connection,
    sql: new RelationalSqlStore(connection),
    close: async () => {
      connection.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
