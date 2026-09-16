import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { kubernetesRun } from './kubernetes-run.mjs'

test('resumed cleanup refuses changed clusters, foreign owners and replacement namespaces', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'caelestis-ownership-'))
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(output, { recursive: true, force: true })
  })
  const inventory = {
    context: 'fixture',
    namespace: 'caelestis-test-owned',
    server: 'https://fixture.test',
    run: 'owner',
    uid: 'original',
    volumes: [],
    resources: [],
  }
  await writeFile(join(output, 'inventory.json'), JSON.stringify(inventory))
  let cluster = inventory.server
  let label = inventory.run
  let uid = inventory.uid
  const commands = []
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'kubectl')
    assert.deepEqual(args.slice(0, 2), ['--context', 'fixture'])
    commands.push(args.slice(2))
    if (args[2] === 'config')
      return JSON.stringify({ clusters: [{ cluster: { server: cluster } }] })
    if (args[2] === 'get' && args[3] === 'namespace')
      return JSON.stringify({ metadata: { uid, labels: { 'caelestis.test/run': label } } })
    throw new Error(`Unexpected cluster mutation: ${args.join(' ')}`)
  })
  syncBuiltinESMExports()
  const open = () => kubernetesRun({ ...inventory, output, resume: true })
  cluster = 'https://replacement.test'
  assert.throws(open, /Cluster endpoint changed/)
  cluster = inventory.server
  label = 'foreign'
  await assert.rejects(open().cleanup(), /ownership mismatch/)
  label = inventory.run
  uid = 'replacement'
  await assert.rejects(open().cleanup(), /Namespace was replaced/)
  assert.ok(commands.every(([verb]) => verb === 'config' || verb === 'get'))
})
