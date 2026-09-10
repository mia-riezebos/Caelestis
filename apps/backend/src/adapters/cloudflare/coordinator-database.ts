import type { CoordinatorDatabase } from '../../coordination/database.js'

/** SQLite-backed Durable Object transactions also include SQL executed through storage.sql. */
export const durableCoordinatorDatabase = (storage: DurableObjectStorage): CoordinatorDatabase => {
  const database: CoordinatorDatabase = {
    dialect: 'sqlite',
    all: async <T>(query: string, ...values: (string | number | null)[]) =>
      storage.sql.exec(query, ...values).toArray() as T[],
    one: async <T>(query: string, ...values: (string | number | null)[]) =>
      storage.sql.exec(query, ...values).one() as T,
    run: async (query, ...values) => ({
      rowsWritten: storage.sql.exec(query, ...values).rowsWritten,
    }),
    transaction: (operation) => storage.transaction(() => operation(database)),
  }
  return database
}
