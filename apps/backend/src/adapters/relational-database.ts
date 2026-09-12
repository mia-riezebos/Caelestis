import { drizzle, type SqliteRemoteResult } from 'drizzle-orm/sqlite-proxy'
import type { SqlConnection } from './sql-connection.js'

/** Share query construction and row decoding across relational adapters. */
export const relationalDatabase = (connection: SqlConnection) =>
  drizzle(
    async (query, parameters, method) => {
      const statement = connection.prepare(query).bind(...parameters)
      if (method === 'run') return { rows: [(await statement.run()).meta.changes] }
      const rows = await statement.raw()
      return { rows: method === 'get' ? (rows[0] ?? []) : rows }
    },
    async (queries) => {
      const results = await connection.batch(
        queries.map(({ sql, params }) => connection.prepare(sql).bind(...params)),
      )
      return results.map((result, index) => ({
        rows:
          queries[index]?.method === 'run'
            ? [result.meta.changes]
            : result.results.map((row) => Object.values(row as Record<string, unknown>)),
      }))
    },
  )

/** The SQL execution callback returns the affected-row count for mutation queries. */
export const changedRows = (result: SqliteRemoteResult | undefined): number =>
  Number(result?.rows?.[0] ?? 0)
