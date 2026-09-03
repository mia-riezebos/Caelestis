import { millis } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from './adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from './adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from './adapters/memory/memory-sql-store.js'
import { type AppOptions, createApp } from './app.js'
import { makeBackendContext } from './runtime/backend-runtime.js'

const BOOTSTRAP = 'bootstrap-operator-token'
const HASH = 'a'.repeat(64)
const BYTES = new Uint8Array([137, 80, 78, 71])

const harness = async (options: AppOptions = {}) => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  await blobs.put('chunks', HASH, BYTES)
  const app = createApp(
    makeBackendContext(blobs, sql, new MemoryCounterStore(sql, () => millis(Date.now()))),
    { bootstrapAdminToken: BOOTSTRAP, currentSeason: 7, ...options },
  )
  return app
}

const bearer = { authorization: `Bearer ${BOOTSTRAP}` }

describe.each([
  ['versioned', '/v1'],
  ['legacy', ''],
] as const)('%s application API', (_name, prefix) => {
  it('serves reads with the same contract and CORS policy', async () => {
    const app = await harness()
    const response = await app.request(`${prefix}/server`, {
      headers: { origin: 'https://wplace.live' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await expect(response.json()).resolves.toEqual({
      id: '00000000-0000-7000-8000-000000000000',
      name: 'Template Server',
      auth: 'access_token',
    })
  })

  it('accepts writes with the same authentication and body contract', async () => {
    const app = await harness()
    const response = await app.request(`${prefix}/admin/tokens`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ label: `${prefix || 'legacy'} reader`, scope: 'read' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      label: `${prefix || 'legacy'} reader`,
      scope: 'read',
      token: expect.any(String),
    })
  })

  it('returns the same validation errors', async () => {
    const app = await harness()
    const response = await app.request(`${prefix}/manifest?season=invalid`, { headers: bearer })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'season must be a non-negative integer',
    })
  })

  it('serves the same authenticated binary assets and cache headers', async () => {
    const app = await harness()
    const response = await app.request(`${prefix}/chunks/${HASH}`, { headers: bearer })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES)
  })

  it('authenticates and forwards live WebSocket upgrades', async () => {
    const connectStatusLive = vi.fn(async () => new Response(null, { status: 204 }))
    const app = await harness({ connectStatusLive })
    const protocol = `caelestis.live.v1, caelestis.auth.b64.${btoa(BOOTSTRAP).replace(/=+$/, '')}`
    const response = await app.request(`${prefix}/telemetry/live?season=7&scope=admin`, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol },
    })

    expect(response.status).toBe(204)
    expect(connectStatusLive).toHaveBeenCalledOnce()
  })
})

it('keeps health outside the versioned application API', async () => {
  const app = await harness()

  expect((await app.request('/health')).status).toBe(200)
  expect((await app.request('/v1/health')).status).toBe(404)
})
