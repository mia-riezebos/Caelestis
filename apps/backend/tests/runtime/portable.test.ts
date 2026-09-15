import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { readNodeConfig } from '../../src/node/config.js'
import { openNodeRuntime } from '../../src/node/runtime.js'
import { listenNodeServer } from '../../src/node/server.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

it('serves authenticated HTTP and upgrades, revokes, and closes real WebSockets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-runtime-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    PORT: '0',
    HOST: '127.0.0.1',
    ADMIN_TOKEN: 'runtime-admin',
  })
  const runtime = await openNodeRuntime(
    config,
    new FilesystemObjectStorage(join(directory, 'objects')),
    {
      onOwnershipLost() {},
    },
  )
  const listener = process.versions.bun
    ? (await import('../../src/bun/server.js')).listenBunServer
    : listenNodeServer
  const server = await listener(runtime, config)
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${server.port}`
  expect((await fetch(`${base}/health/ready`)).status).toBe(200)
  expect((await fetch(`${base}/backend/v1/manifest`)).status).toBe(401)
  expect(
    (
      await fetch(`${base}/backend/v1/manifest`, {
        headers: { authorization: `Bearer ${runtime.readToken}` },
      })
    ).status,
  ).toBe(200)

  const minted = await fetch(`${base}/backend/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer runtime-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'runtime reporter', scope: 'report' }),
  })
  expect(minted.status).toBe(201)
  const credential = (await minted.json()) as { token: string; tokenHash: string }
  const presence = new WebSocket(
    `${base.replace('http', 'ws')}/backend/v1/telemetry/presence?season=0&painterId=42&painterName=Mia&clientId=01890f3e-7b2c-7abc-8def-000000000005`,
    [
      'caelestis.presence.v1',
      `caelestis.auth.b64.${Buffer.from(credential.token).toString('base64url')}`,
    ],
  )
  const ready = once(presence, 'message')
  await once(presence, 'open')
  expect(JSON.parse(String((await ready)[0]))).toMatchObject({ type: 'presence-ready', online: 1 })
  const revoked = once(presence, 'close')
  expect(
    (
      await fetch(`${base}/backend/v1/admin/tokens/${credential.tokenHash}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runtime-admin' },
      })
    ).status,
  ).toBe(204)
  expect((await revoked)[0]).toBe(1008)

  const live = new WebSocket(
    `${base.replace('http', 'ws')}/api/v1/telemetry/live?season=0&scope=public&stateVector=1`,
    ['caelestis.live.v2'],
  )
  await once(live, 'open')
  expect(live.protocol).toBe('caelestis.live.v2')
  const pong = once(live, 'message')
  live.send('ping')
  expect(String((await pong)[0])).toBe('pong')
  const closed = once(live, 'close')
  await server.close()
  expect((await closed)[0]).toBe(1001)
})
