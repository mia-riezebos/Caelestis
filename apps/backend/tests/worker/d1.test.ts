import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeTemplateContractExpected } from '../support/sql-contract.js'

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')
const runtimes: Miniflare[] = []

const openD1 = async () => {
  const bundled = await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'd1-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  const worker = bundled.outputFiles[0]
  if (worker === undefined) throw new Error('D1 worker bundle did not produce JavaScript')
  const runtime = new Miniflare({
    modules: true,
    script: worker.text,
    compatibilityDate: '2026-07-30',
    d1Databases: ['DB'],
  })
  runtimes.push(runtime)
  for (const file of (await readdir(migrationDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = await runtime.dispatchFetch('https://d1.test/migrate', {
      method: 'POST',
      body: await readFile(join(migrationDirectory, file), 'utf8'),
    })
    expect(migration.status, await migration.text()).toBe(204)
  }
  return runtime
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
})

describe('D1 relational adapter contract', () => {
  it('persists stable token order and sparse server-setting writes through the real D1 binding', async () => {
    const runtime = await openD1()
    expect(await (await runtime.dispatchFetch('https://d1.test/contract')).json()).toEqual({
      tokenHashes: ['a'.repeat(64), 'b'.repeat(64)],
      settings: { name: 'D1 server', description: 'real binding' },
      nodeTemplate: nodeTemplateContractExpected,
    })
  })
})
