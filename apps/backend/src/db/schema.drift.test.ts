import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.js'

/** The schema source and the final database produced by every committed migration must agree. */
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

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }))
const committed = migrations.map(({ sql }) => sql).join('\n')

const normalise = (value: string): string => value.replace(/[`"]/g, '').replace(/\s+/g, ' ').trim()

const checkBodies = (sql: string): string[] => {
  const checks: string[] = []
  const marker = /\bCHECK\s*\(/gi
  for (let match = marker.exec(sql); match !== null; match = marker.exec(sql)) {
    let depth = 1
    let quote = false
    let index = marker.lastIndex
    for (; index < sql.length && depth > 0; index += 1) {
      const character = sql[index]
      if (character === "'") {
        if (quote && sql[index + 1] === "'") index += 1
        else quote = !quote
      } else if (!quote && character === '(') depth += 1
      else if (!quote && character === ')') depth -= 1
    }
    checks.push(normalise(sql.slice(marker.lastIndex, index - 1)))
    marker.lastIndex = index
  }
  return checks.sort()
}

const finalSchema = (migration: string) => {
  const database = new DatabaseSync(':memory:')
  database.exec(migration.replaceAll('--> statement-breakpoint', ''))
  const tableRows = database
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string; sql: string }>
  const tables = tableRows
    .map(({ name, sql }) => ({
      name,
      columns: (
        database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<
          Record<string, unknown>
        >
      )
        .map(({ name: column, type, notnull, dflt_value: defaultValue, pk }) => ({
          name: String(column),
          type: String(type),
          notNull: Number(notnull),
          defaultValue: defaultValue === null ? null : String(defaultValue),
          primaryKeyOrder: Number(pk),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      foreignKeys: (
        database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as Array<
          Record<string, unknown>
        >
      )
        .map((row) => JSON.stringify(row))
        .sort(),
      checks: checkBodies(sql),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const indexes = (
    database
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all() as Array<{ name: string; tbl_name: string; sql: string }>
  )
    .map(({ name, tbl_name: table, sql }) => ({ name, table, sql: normalise(sql) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  database.close()
  return { tables, indexes }
}

describe('the Drizzle schema and migration history agree', () => {
  it('produce the same final schema', async () => {
    const empty = await generateSQLiteDrizzleJson({})
    // biome-ignore lint/suspicious/noExplicitAny: drizzle-kit's api types are not exported
    const current = await generateSQLiteDrizzleJson(schema as any)
    const generated = await generateSQLiteMigration(empty, current)

    expect(finalSchema(committed)).toEqual(finalSchema(generated.join('\n')))
  })

  it('compares a non-empty set of statements, so agreement is not vacuous', () => {
    expect(statements(committed).length).toBeGreaterThan(10)
  })

  it('applies the rebased stack after the published PRD migrations', () => {
    const database = new DatabaseSync(':memory:')
    const lastSharedIndex = migrations.findIndex(
      ({ name }) => name === '0008_magenta_hemingway.sql',
    )
    expect(lastSharedIndex).toBeGreaterThan(0)
    const shared = migrations.slice(0, lastSharedIndex + 1)
    database.exec(
      shared
        .map(({ sql }) => sql)
        .join('\n')
        .replaceAll('--> statement-breakpoint', ''),
    )

    const statusRevision = migrations.find(({ sql }) =>
      sql.includes('CREATE TABLE `status_read_model_revisions`'),
    )
    const dirtyFingerprints = migrations.find(({ sql }) =>
      sql.includes('CREATE TABLE `__new_status_read_model_revisions`'),
    )
    expect(statusRevision).toBeDefined()
    expect(dirtyFingerprints).toBeDefined()
    database.exec(
      `${statusRevision?.sql ?? ''}\n${dirtyFingerprints?.sql ?? ''}`.replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    )

    const applied = new Set([
      ...shared.map(({ name }) => name),
      '0009_breezy_red_skull.sql',
      '0010_charming_photon.sql',
    ])
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue
      database.exec(migration.sql.replaceAll('--> statement-breakpoint', ''))
    }

    expect(
      database.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('canvas_tiles'),
    ).toContainEqual({ name: 'commit_order' })
    expect(
      database.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('nodes'),
    ).toContainEqual({ name: 'surface_kind' })
    database.close()
  })

  it('upgrades the historical schema needed by server-backed progress', () => {
    const database = new DatabaseSync(':memory:')
    const repairIndex = migrations.findIndex(
      ({ name }) => name === '0002_repair-progress-schema.sql',
    )
    expect(repairIndex).toBeGreaterThan(0)
    database.exec(
      migrations
        .slice(0, repairIndex)
        .map(({ sql }) => sql)
        .join('\n')
        .replaceAll('--> statement-breakpoint', ''),
    )
    database
      .prepare('INSERT INTO tile_history VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(325, 1781, 0, 1_787_657_000, 'a'.repeat(64), 'b'.repeat(64), 42)
    database.exec(
      migrations
        .slice(repairIndex)
        .map(({ sql }) => sql)
        .join('\n')
        .replaceAll('--> statement-breakpoint', ''),
    )

    const columns = (table: string): string[] =>
      database
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(table)
        .map((row) => String(row.name))

    expect(columns('tile_history')).toContain('season')
    expect(columns('template_versions')).toContain('colour_totals_json')
    expect(database.prepare('SELECT season, tile_x, tile_y FROM tile_history').get()).toEqual({
      season: 0,
      tile_x: 325,
      tile_y: 1781,
    })
    database.close()
  })

  it('migrates existing templates onto the world surface', () => {
    const database = new DatabaseSync(':memory:')
    const surfaceIndex = migrations.findIndex(
      ({ name }) => name === '0006_alliance-template-surfaces.sql',
    )
    expect(surfaceIndex).toBeGreaterThan(0)
    database.exec(
      migrations
        .slice(0, surfaceIndex)
        .map(({ sql }) => sql)
        .join('\n')
        .replaceAll('--> statement-breakpoint', ''),
    )
    database
      .prepare(
        `INSERT INTO templates (
          id, season, node_id, name, current_version_id, published_at,
          created_with_token, created_by_user_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run('legacy', 1, 'Legacy', 'a'.repeat(64), 1_000, 1_000)
    database
      .prepare(
        `INSERT INTO template_versions (
          id, template_id, created_at_ms, created_with_token, created_by_user_id,
          min_x, min_y, max_x, max_y, total_pixels,
          bounds_north, bounds_south, bounds_west, bounds_east
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run('legacy-version', 'legacy', 1_000, 'a'.repeat(64), 0, 0, 1, 1, 1)
    database
      .prepare('INSERT INTO version_tiles (version_id, tile_x, tile_y, hash) VALUES (?, ?, ?, ?)')
      .run('legacy-version', 0, 0, 'b'.repeat(64))
    database
      .prepare('UPDATE templates SET current_version_id = ? WHERE id = ?')
      .run('legacy-version', 'legacy')
    database
      .prepare(
        `INSERT INTO template_tile_statuses (
          template_id, version_id, tile_x, tile_y, correct, wrong, blank,
          colours_json, observed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy', 'legacy-version', 0, 0, 1, 2, 3, '{}', 1_000)

    for (const migration of migrations.slice(surfaceIndex)) {
      database.exec(`BEGIN;\n${migration.sql.replaceAll('--> statement-breakpoint', '')}\nCOMMIT;`)
    }

    expect(
      database
        .prepare('SELECT surface_kind, alliance_id FROM templates WHERE id = ?')
        .get('legacy'),
    ).toEqual({ surface_kind: 'world', alliance_id: null })
    expect(
      database
        .prepare('SELECT template_id, min_x, min_y FROM template_versions WHERE id = ?')
        .get('legacy-version'),
    ).toEqual({ template_id: 'legacy', min_x: 0, min_y: 0 })
    expect(
      database
        .prepare('SELECT version_id, tile_x, tile_y FROM version_tiles WHERE version_id = ?')
        .get('legacy-version'),
    ).toEqual({ version_id: 'legacy-version', tile_x: 0, tile_y: 0 })
    expect(
      database
        .prepare(
          `SELECT template_id, version_id, correct, wrong, blank
           FROM template_tile_statuses WHERE template_id = ?`,
        )
        .get('legacy'),
    ).toEqual({
      template_id: 'legacy',
      version_id: 'legacy-version',
      correct: 1,
      wrong: 2,
      blank: 3,
    })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    database.close()
  })

  it('migrates existing nodes onto the world surface', () => {
    const database = new DatabaseSync(':memory:')
    const surfaceIndex = migrations.findIndex(
      ({ name }) => name === '0009_careful_steel_serpent.sql',
    )
    expect(surfaceIndex).toBeGreaterThan(0)
    database.exec(
      migrations
        .slice(0, surfaceIndex)
        .map(({ sql }) => sql)
        .join('\n')
        .replaceAll('--> statement-breakpoint', ''),
    )
    const insertNode = database.prepare(
      `INSERT INTO nodes (
        id, season, parent_id, path, name, description, delete_token, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    insertNode.run('legacy-node', 1, null, '/legacy', 'Legacy', 1_000)
    insertNode.run('legacy-child', 1, 'legacy-node', '/legacy/child', 'Child', 1_001)
    database
      .prepare(
        `INSERT INTO templates (
          id, season, node_id, name, current_version_id, published_at,
          created_with_token, created_by_user_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run('legacy-template', 1, 'legacy-child', 'Legacy template', '0'.repeat(64), 1_002, 1_002)

    for (const migration of migrations.slice(surfaceIndex)) {
      database.exec(`BEGIN;\n${migration.sql.replaceAll('--> statement-breakpoint', '')}\nCOMMIT;`)
    }

    expect(
      database
        .prepare('SELECT surface_kind, alliance_id FROM nodes WHERE id = ?')
        .get('legacy-node'),
    ).toEqual({ surface_kind: 'world', alliance_id: null })
    expect(
      database.prepare('SELECT parent_id FROM nodes WHERE id = ?').get('legacy-child'),
    ).toEqual({ parent_id: 'legacy-node' })
    expect(
      database.prepare('SELECT node_id FROM templates WHERE id = ?').get('legacy-template'),
    ).toEqual({ node_id: 'legacy-child' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    database.close()
  })
})
