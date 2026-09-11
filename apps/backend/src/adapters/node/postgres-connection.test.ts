import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PostgresConnection, postgresParameters } from './postgres-connection.js'
import { SqliteConnection } from './sqlite-connection.js'

it('preserves quoted markers and repeated numbered parameters', () => {
  expect(postgresParameters(`SELECT '?', "?", ?1, ?1, ?, 'it''s ?'`)).toBe(
    `SELECT '?', "?", $1, $1, $2, 'it''s ?'`,
  )
})

describe.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)('PostgreSQL persistence', () => {
  it('invalidates old public status caches once while retaining other coordinator state', async () => {
    const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
    const connection = new PostgresConnection({
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    })
    const baseline = await mkdtemp(join(tmpdir(), 'caelestis-pg-baseline-'))
    const migrations = join(import.meta.dirname, '../../../migrations-postgres')
    await connection.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      await copyFile(
        join(migrations, '0000_portable_baseline.sql'),
        join(baseline, '0000_portable_baseline.sql'),
      )
      await connection.migrate(baseline)
      await connection.pool.query(`
        CREATE TABLE runtime_values (actor TEXT, key TEXT, value TEXT, PRIMARY KEY(actor, key));
        INSERT INTO runtime_values VALUES
          ('season:0', 'status-read-model:v2:manifest', 'old'),
          ('season:0', 'status-read-model:v2:chunk:0', 'old'),
          ('season:0', 'manifest', 'keep'),
          ('counter:0', 'pending', 'keep');
      `)
      await connection.migrate(migrations)
      expect((await connection.pool.query('SELECT value FROM runtime_values')).rows).toEqual([
        { value: 'keep' },
        { value: 'keep' },
      ])
      await connection.pool.query(
        "INSERT INTO runtime_values VALUES ('season:0', 'status-read-model:v2:manifest', 'rebuilt')",
      )
      await connection.migrate(migrations)
      expect(
        (
          await connection.pool.query(
            "SELECT value FROM runtime_values WHERE key = 'status-read-model:v2:manifest'",
          )
        ).rows,
      ).toEqual([{ value: 'rebuilt' }])
    } finally {
      await connection.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await connection.close()
      await rm(baseline, { recursive: true, force: true })
    }
  })

  it('matches SQLite tables and columns, reruns migrations safely, and preserves committed data on reconnect', async () => {
    const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const first = new PostgresConnection(config)
    const sqlite = new SqliteConnection(':memory:')
    await first.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      sqlite.migrate(join(import.meta.dirname, '../../../migrations'))
      await first.migrate(join(import.meta.dirname, '../../../migrations-postgres'))
      await first.migrate(join(import.meta.dirname, '../../../migrations-postgres'))
      const pgColumns = await first.pool.query<{
        table_name: string
        column_name: string
        data_type: string
      }>(
        'SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, column_name',
      )
      const tables = sqlite.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
      const sqliteColumns = tables
        .flatMap(({ name }) =>
          sqlite.sqlite
            .prepare(`PRAGMA table_info("${name}")`)
            .all()
            .map((column) => ({
              table_name: String(name),
              column_name: String(column.name),
              data_type:
                String(column.type).toLowerCase() === 'integer'
                  ? 'bigint'
                  : String(column.type).toLowerCase() === 'real'
                    ? 'double precision'
                    : String(column.type).toLowerCase(),
            })),
        )
        .sort((left, right) =>
          `${left.table_name}.${left.column_name}`.localeCompare(
            `${right.table_name}.${right.column_name}`,
            'en',
          ),
        )
      expect(
        pgColumns.rows.sort((left, right) =>
          `${left.table_name}.${left.column_name}`.localeCompare(
            `${right.table_name}.${right.column_name}`,
            'en',
          ),
        ),
      ).toEqual(sqliteColumns)
      await first.prepare("INSERT INTO server_settings (id, name) VALUES (1, 'Accepted')").run()
      await expect(
        first.batch([
          first.prepare("UPDATE server_settings SET name = 'Uncommitted' WHERE id = 1"),
          first.prepare('INSERT INTO server_settings (id) VALUES (1)'),
        ]),
      ).rejects.toThrow()
    } finally {
      sqlite.close()
      await first.close()
    }
    const second = new PostgresConnection(config)
    try {
      expect(await second.prepare('SELECT name FROM server_settings WHERE id = 1').first()).toEqual(
        { name: 'Accepted' },
      )
    } finally {
      await second.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await second.close()
    }
  })
})
