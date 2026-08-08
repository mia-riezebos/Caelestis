import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.js'

/**
 * The Drizzle schema is the source `db:generate` reads; the migration is what actually runs, both in
 * production and in every test. Nothing connected the two, so deleting any `check(...)` from
 * `schema.ts` left the whole suite green — the constraint stayed in the committed SQL, the tests
 * kept exercising it, and the schema quietly stopped describing the database.
 *
 * An earlier version of this file compared constraint *names*. That was far weaker than it read:
 * weakening a CHECK body, changing a primary key, dropping a column, removing a foreign key or
 * making a unique index non-unique all kept their names and so all passed. Nine such mutations
 * survived it.
 *
 * This regenerates the migration from `schema.ts` through drizzle-kit's own API — the same code path
 * `db:generate` uses — and compares it to what is committed. Any divergence at all fails, which is
 * the only version of this check that means what it says.
 */
const migrationsDir = join(import.meta.dirname, '../../migrations')

/**
 * Statements, whitespace-normalised and sorted, so neither formatting nor emission order is a
 * failure — drizzle-kit's API and its CLI order tables differently, and SQLite does not care.
 */
const statements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .flatMap((chunk) => chunk.split(';'))
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0)
    .sort()

const committed = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n')

describe('the Drizzle schema and the baseline migration agree', () => {
  it('regenerates the committed migration exactly', async () => {
    const empty = await generateSQLiteDrizzleJson({})
    // biome-ignore lint/suspicious/noExplicitAny: drizzle-kit's api types are not exported
    const current = await generateSQLiteDrizzleJson(schema as any)
    const generated = await generateSQLiteMigration(empty, current)

    expect(statements(generated.join('\n'))).toEqual(statements(committed))
  })

  it('compares a non-empty set of statements, so agreement is not vacuous', () => {
    expect(statements(committed).length).toBeGreaterThan(10)
  })
})
