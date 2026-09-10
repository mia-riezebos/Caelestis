import { type AnyColumn, sql } from 'drizzle-orm'

/** The few expressions that differ between SQLite/D1 and PostgreSQL. */
export const sqlDialect = (dialect: 'sqlite' | 'postgres' = 'sqlite') => {
  const postgres = dialect === 'postgres'
  return {
    nullEqual: postgres ? 'IS NOT DISTINCT FROM' : 'IS',
    greatest: postgres ? 'greatest' : 'max',
    jsonEach: postgres ? 'jsonb_array_elements(?::jsonb)' : 'json_each(?)',
    previousChanged: postgres
      ? "current_setting('caelestis.changed_rows')::bigint > 0"
      : 'changes() > 0',
    jsonField: (field: string, type: 'text' | 'bigint' | 'json' = 'bigint') => {
      if (!postgres) return `json_extract(value, '$.${field}')`
      if (type === 'json') return `(value -> '${field}')::text`
      return `(value ->> '${field}')::${type}`
    },
    jsonAggregate: (column: AnyColumn) =>
      postgres ? sql<string>`json_agg(${column})::text` : sql<string>`json_group_array(${column})`,
  }
}
