import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SqliteConnection } from './sqlite-connection.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('persists committed batches across reopen and rolls back failed batches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'caelestis-sqlite-'))
  directories.push(directory)
  const filename = join(directory, 'db.sqlite')
  const first = new SqliteConnection(filename)
  await first.prepare('CREATE TABLE items (id TEXT PRIMARY KEY)').run()
  await first.batch([first.prepare('INSERT INTO items VALUES (?)').bind('accepted')])
  await expect(
    first.batch([
      first.prepare('INSERT INTO items VALUES (?)').bind('uncommitted'),
      first.prepare('INSERT INTO items VALUES (?)').bind('accepted'),
    ]),
  ).rejects.toThrow()
  first.close()
  const second = new SqliteConnection(filename)
  try {
    expect((await second.prepare('SELECT * FROM items').all()).results).toEqual([
      { id: 'accepted' },
    ])
  } finally {
    second.close()
  }
})

it('rejects changed migrations and leaves failed migrations unapplied', () => {
  const directory = mkdtempSync(join(tmpdir(), 'caelestis-migrations-'))
  directories.push(directory)
  const database = new SqliteConnection(':memory:')
  try {
    writeFileSync(join(directory, '0001.sql'), 'CREATE TABLE items (id TEXT PRIMARY KEY);')
    database.migrate(directory)
    database.migrate(directory)
    writeFileSync(join(directory, '0002.sql'), 'CREATE TABLE partial (id TEXT); INVALID SQL;')
    expect(() => database.migrate(directory)).toThrow()
    expect(
      database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").all(),
    ).toEqual([])
    writeFileSync(join(directory, '0001.sql'), 'SELECT 1;')
    expect(() => database.migrate(directory)).toThrow('Migration changed after application')
  } finally {
    database.close()
  }
})
