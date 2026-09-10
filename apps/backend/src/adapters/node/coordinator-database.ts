import type { CoordinatorDatabase } from '../../coordination/database.js'
import type { SqlConnection, TransactionalSqlConnection } from '../sql-connection.js'

/** Coordinator operations share the configured application database. */
export const coordinatorDatabase = (root: TransactionalSqlConnection): CoordinatorDatabase => {
  const scoped = (connection: SqlConnection, inTransaction = false): CoordinatorDatabase => ({
    dialect: connection.dialect ?? 'sqlite',
    async all<T>(query: string, ...values: (string | number | null)[]) {
      return (
        await connection
          .prepare(query)
          .bind(...values)
          .all<T>()
      ).results
    },
    async one<T>(query: string, ...values: (string | number | null)[]) {
      const result = await connection
        .prepare(query)
        .bind(...values)
        .first<T>()
      if (result === null) throw new Error('Expected one coordinator row')
      return result
    },
    async run(query, ...values) {
      return {
        rowsWritten: (
          await connection
            .prepare(query)
            .bind(...values)
            .run()
        ).meta.changes,
      }
    },
    transaction: (operation) =>
      inTransaction
        ? operation(scoped(connection, true))
        : root.transaction((transaction) => operation(scoped(transaction, true))),
  })
  return scoped(root)
}
