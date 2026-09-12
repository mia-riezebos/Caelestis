import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqlDialect } from '../sql-dialect.js'
import { mariaTestDatabase } from './mariadb.test-helper.js'
import { MariaConnection } from './mariadb-connection.js'

describe.skipIf(!process.env.CAELESTIS_TEST_MARIADB_URL)('MariaDB connection', () => {
  let harness: Awaited<ReturnType<typeof mariaTestDatabase>>
  let db: MariaConnection
  beforeEach(async () => {
    harness = await mariaTestDatabase()
    db = harness.connection
    await db
      .prepare(
        'CREATE TABLE sample (id INTEGER PRIMARY KEY, value INTEGER NOT NULL CHECK (value >= 0))',
      )
      .run()
  })
  afterEach(async () => {
    await harness?.close()
  })

  it('repeats numbered parameters and preserves literals without SQL interpolation', async () => {
    const value = "?2 ' \\ ON CONFLICT §0§"
    expect(
      await db
        .prepare("SELECT ?2 AS second, ?1 AS first, ?2 AS again, '?1' AS literal")
        .bind(42, value)
        .first(),
    ).toEqual({ second: value, first: 42, again: value, literal: '?1' })
  })
  it('ignores only duplicate keys, preserving validation failures and change counts', async () => {
    const statement = 'INSERT INTO sample (id, value) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
    expect((await db.prepare(statement).bind(1, 2).run()).meta.changes).toBe(1)
    expect((await db.prepare(statement).bind(1, 4).run()).meta.changes).toBe(0)
    await expect(db.prepare(statement).bind(2, -1).run()).rejects.toThrow()
    expect(await db.prepare('SELECT * FROM sample').all()).toMatchObject({
      results: [{ id: 1, value: 2 }],
    })
  })
  it('preserves JSON strings, nulls, Unicode lengths, and safe integer boundaries', async () => {
    const syntax = sqlDialect('mariadb')
    const query = `SELECT ${syntax.jsonField('text', 'text')} AS text, ${syntax.jsonField('missing', 'text')} AS missing FROM ${syntax.jsonEach}`
    expect(
      (
        await db
          .prepare(query)
          .bind(JSON.stringify([{ text: 'null', missing: null }, { text: '🦊' }]))
          .all()
      ).results,
    ).toEqual([
      { text: 'null', missing: null },
      { text: '🦊', missing: null },
    ])
    expect(await db.prepare('SELECT length(?1) AS size').bind('🦊').first()).toEqual({ size: 1 })
    await expect(
      db.prepare('SELECT CAST(9007199254740993 AS SIGNED) AS value').first(),
    ).rejects.toThrow()
  })
  it('applies conditional updates using the old row and omits rejected RETURNING rows', async () => {
    const statement =
      'INSERT INTO sample (id, value) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET value = excluded.value WHERE sample.value < excluded.value RETURNING id, value'
    expect(await db.prepare(statement).bind(1, 4).first()).toEqual({ id: 1, value: 4 })
    expect(await db.prepare(statement).bind(1, 2).first()).toBeNull()
    expect(await db.prepare(statement).bind(1, 6).first()).toEqual({ id: 1, value: 6 })
  })
  it('rolls back a failed batch and a failed asynchronous transaction', async () => {
    await expect(
      db.batch([
        db.prepare('INSERT INTO sample VALUES (1, 1)'),
        db.prepare('INSERT INTO sample VALUES (2, -1)'),
      ]),
    ).rejects.toThrow()
    await expect(
      db.transaction(async (tx) => {
        await tx.prepare('INSERT INTO sample VALUES (3, 1)').run()
        throw new Error('cancel')
      }),
    ).rejects.toThrow('cancel')
    expect((await db.prepare('SELECT * FROM sample').all()).results).toEqual([])
  })
  it('fences a disconnected owner and permits a replacement', async () => {
    const rival = new MariaConnection(harness.config)
    try {
      let reportLost: (error: Error) => void = () => {}
      const lost = new Promise<Error>((resolve) => {
        reportLost = resolve
      })
      await db.claimOwnership(reportLost)
      await expect(rival.claimOwnership(() => {})).rejects.toThrow('Another Caelestis')
      const row = await db.prepare('SELECT CONNECTION_ID() AS id').first<{ id: number }>()
      await harness.admin.prepare(`KILL CONNECTION ${row?.id}`).run()
      await lost
      await expect(db.prepare('SELECT 1').run()).rejects.toThrow()
      await rival.claimOwnership(() => {})
    } finally {
      await rival.close()
    }
  })
  it('verifies migration checksums and refuses interrupted DDL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-maria-migrations-'))
    try {
      await writeFile(
        join(directory, '0000.sql'),
        "-- a comment; with a semicolon\nCREATE TABLE migrated (id INTEGER, value TEXT); INSERT INTO migrated VALUES (1, 'one;--two');",
      )
      await db.migrate(directory)
      await db.migrate(directory)
      expect(await db.prepare('SELECT * FROM migrated').first()).toEqual({
        id: 1,
        value: 'one;--two',
      })
      await writeFile(join(directory, '0000.sql'), 'CREATE TABLE changed (id INTEGER);')
      await expect(db.migrate(directory)).rejects.toThrow('Migration changed')
      await db.prepare('DELETE FROM caelestis_migrations').run()
      await writeFile(
        join(directory, '0000.sql'),
        'CREATE TABLE partial (id INTEGER); INVALID SQL;',
      )
      await expect(db.migrate(directory)).rejects.toThrow()
      await expect(db.migrate(directory)).rejects.toThrow('Interrupted MariaDB migration')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
