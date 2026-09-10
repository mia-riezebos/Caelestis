import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { PostgresConnection } from '../adapters/node/postgres-connection.js'
import { readNodeConfig } from './config.js'
import { openNodeRuntime } from './runtime.js'
import { type FrontendHandler, listenNodeServer } from './server.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

const adapters = ['sqlite', ...(process.env.CAELESTIS_TEST_POSTGRES_URL ? ['postgres'] : [])]
it('bootstraps a separate frontend credential without restoring it after revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-frontend-token-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  expect(() => readNodeConfig({ ADMIN_TOKEN: 'same', CAELESTIS_READ_TOKEN: 'same' })).toThrow(
    'different credentials',
  )
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    ADMIN_TOKEN: 'admin-test',
    CAELESTIS_READ_TOKEN: 'frontend-test',
  })
  const storage = new FilesystemObjectStorage(join(directory, 'objects'))
  const runtime = await openNodeRuntime(config, storage, { onOwnershipLost() {} })
  expect(runtime.readToken).toBe('frontend-test')
  expect(await runtime.connection.prepare('SELECT scope FROM access_tokens').first()).toEqual({
    scope: 'read',
  })
  await runtime.connection.prepare('DELETE FROM access_tokens').run()
  await runtime.close()
  await expect(openNodeRuntime(config, storage, { onOwnershipLost() {} })).rejects.toThrow(
    'active read-only token',
  )
})

it.each(adapters)(
  '%s serves authenticated HTTP and real v2 WebSockets across a restart',
  async (adapter) => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-server-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const schema = `runtime_${crypto.randomUUID().replaceAll('-', '')}`
    const configured = readNodeConfig({
      DB_ADAPTER: adapter,
      ...(adapter === 'postgres'
        ? { DATABASE_URL: process.env.CAELESTIS_TEST_POSTGRES_URL, PG_TLS_MODE: 'disable' }
        : {}),
      DATA_DIRECTORY: directory,
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_TOKEN: 'test-admin',
    })
    const config = { ...configured, pg: { ...configured.pg, options: `-c search_path=${schema}` } }
    if (adapter === 'postgres') {
      const admin = new PostgresConnection(config.pg)
      await admin.pool.query(`CREATE SCHEMA ${schema}`)
      cleanup.push(async () => {
        await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`)
        await admin.close()
      })
    }
    let frontend: FrontendHandler | undefined
    if (process.env.CAELESTIS_TEST_FRONTEND_HANDLER) {
      const loaded: { handler: FrontendHandler } = await import(
        pathToFileURL(process.env.CAELESTIS_TEST_FRONTEND_HANDLER).href
      )
      frontend = loaded.handler
    }
    const storage = new FilesystemObjectStorage(join(directory, 'objects'))
    const ownershipLost = vi.fn()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    let runtime = await openNodeRuntime(config, storage, { onOwnershipLost: ownershipLost })
    let server = await listenNodeServer(runtime, config, frontend)
    cleanup.push(() => server.close())
    const id = runtime.serverId
    const token = runtime.readToken
    expect((await fetch(`http://127.0.0.1:${server.port}/health/ready`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${server.port}/backend/v1/manifest`)).status).toBe(401)
    const response = await fetch(`http://127.0.0.1:${server.port}/backend/v1/manifest`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await response.json()).toMatchObject({ server: { id, liveSyncMax: 2 } })
    if (frontend) {
      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain(id)
      expect(html).not.toContain(token)
      const manifest = await fetch(`http://127.0.0.1:${server.port}/api/v1/manifest`)
      expect(await manifest.json()).toMatchObject({ server: { id } })
    }
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/telemetry/live?season=0&scope=public&stateVector=1`,
      ['caelestis.live.v2'],
    )
    await once(ws, 'open')
    expect(ws.protocol).toBe('caelestis.live.v2')
    let message = once(ws, 'message')
    ws.send('ping')
    expect(String((await message)[0])).toBe('pong')
    message = once(ws, 'message')
    ws.send(
      JSON.stringify({
        type: 'state-vector',
        requestId: '01890f3e-7b2c-7abc-8def-000000000003',
        revision: null,
        projections: [],
      }),
    )
    const first = (await message)[0]
    expect(JSON.parse(String(first))).toMatchObject({
      type: 'status-snapshot',
      status: { templates: [] },
    })
    const closed = once(ws, 'close')
    ws.close()
    await closed
    await server.close()
    runtime = await openNodeRuntime(config, storage, { onOwnershipLost: ownershipLost })
    server = await listenNodeServer(runtime, config, frontend)
    expect(runtime.serverId).toBe(id)
    expect(runtime.readToken).toBe(token)
    expect(ownershipLost).not.toHaveBeenCalled()
  },
)
