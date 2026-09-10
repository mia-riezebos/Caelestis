import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresConnection } from './postgres-connection.js'
import { claimSqliteOwnership } from './sqlite-ownership.js'

it('refuses a second SQLite owner and releases ownership when its process dies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-owner-'))
  const filename = join(directory, 'data.sqlite')
  const moduleUrl = new URL('./sqlite-ownership.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { claimSqliteOwnership } from ${JSON.stringify(moduleUrl)}; claimSqliteOwnership(process.argv[1]); process.stdout.write('ready'); setInterval(() => {}, 1000)`,
      filename,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Owner process exited before acquiring its lock')
      }),
    ])
    expect(() => claimSqliteOwnership(filename)).toThrow('Another Caelestis server')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const release = claimSqliteOwnership(filename)
    release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(!process.env.CAELESTIS_TEST_POSTGRES_URL)(
  'fences a lost PostgreSQL connection and allows a replacement owner',
  async () => {
    const schema = `owner_${crypto.randomUUID().replaceAll('-', '')}`
    const config = {
      connectionString: process.env.CAELESTIS_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    }
    const first = new PostgresConnection(config)
    const second = new PostgresConnection(config)
    await first.pool.query(`CREATE SCHEMA ${schema}`)
    try {
      let reportLost: (error: Error) => void = () => {}
      const lost = new Promise<Error>((resolve) => {
        reportLost = resolve
      })
      await first.claimOwnership(reportLost)
      await expect(second.claimOwnership(() => {})).rejects.toThrow('Another Caelestis server')
      const row = await first.prepare('SELECT pg_backend_pid() AS pid').first<{ pid: number }>()
      await second.pool.query('SELECT pg_terminate_backend($1)', [row?.pid])
      await lost
      await expect(first.prepare('SELECT 1').all()).rejects.toThrow()
      await second.claimOwnership(() => {})
      expect(await second.prepare('SELECT 1 AS value').first()).toEqual({ value: 1 })
      await expect(first.prepare('SELECT 2').all()).rejects.toThrow()
    } finally {
      await second.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await first.close()
      await second.close()
    }
  },
)
