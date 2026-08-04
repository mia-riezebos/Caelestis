import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.js'

/**
 * The Drizzle schema is the source `db:generate` reads; the migration is what actually runs, both
 * in production and in every test. Nothing connected the two, so deleting any `check(...)` from
 * `schema.ts` left the whole suite green — the constraint stayed in the committed SQL, the tests
 * kept exercising it, and the schema quietly stopped describing the database.
 *
 * Regenerating and diffing would be the complete answer, but drizzle-kit names files with a random
 * suffix and needs a writable directory, which makes it a poor fit for a unit test. Comparing the
 * declared constraint *names* against the migration text catches the drift that matters — a
 * constraint added, removed or renamed on one side only — without that cost.
 */
const migrationsDir = join(import.meta.dirname, '../../migrations')
const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n')

const isTable = (value: unknown): value is SQLiteTable => {
  try {
    getTableConfig(value as SQLiteTable)
    return true
  } catch {
    return false
  }
}

const tables: ReadonlyArray<SQLiteTable> = Object.values<unknown>(schema).filter(isTable)

const declaredChecks = tables.flatMap((table) =>
  getTableConfig(table).checks.map((check) => check.name),
)

const migrationChecks = [...migrationSql.matchAll(/CONSTRAINT\s+"([^"]+)"\s+CHECK/g)].map(
  (match) => match[1],
)

describe('Drizzle schema and the baseline migration agree', () => {
  it('declares at least one table and one check, so the comparison is not vacuous', () => {
    expect(tables.length).toBeGreaterThan(0)
    expect(declaredChecks.length).toBeGreaterThan(0)
  })

  it('names the same set of CHECK constraints on both sides', () => {
    expect([...declaredChecks].sort()).toEqual([...migrationChecks].sort())
  })

  it('creates every table the schema declares', () => {
    for (const table of tables) {
      const { name } = getTableConfig(table)
      expect(migrationSql).toContain(`CREATE TABLE \`${name}\``)
    }
  })

  it('creates every index the schema declares', () => {
    for (const table of tables) {
      for (const index of getTableConfig(table).indexes) {
        expect(migrationSql).toContain(`\`${index.config.name}\``)
      }
    }
  })
})
