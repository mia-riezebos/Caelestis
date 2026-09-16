import { encodeIndexedPng } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { adminToken, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

const id = '01890f3e-7b2c-7abc-8def-012345678901'
const hash = 'a'.repeat(64)
type Backend = Awaited<ReturnType<typeof createTestBackend>>
const request = (backend: Backend, path: string, method = 'GET', token?: string, body?: unknown) =>
  backend.app.fetch(
    new Request(`https://backend.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const mint = async (backend: Backend, scope: 'read' | 'report', token = adminToken) => {
  const response = await request(backend, '/admin/tokens', 'POST', token, { label: scope, scope })
  expect(response.status).toBe(201)
  const value = (await response.json()) as { token: string; tokenHash: string }
  expect(value.token).toEqual(expect.any(String))
  expect(value.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  return value
}

const reads = [
  '/manifest',
  `/chunks/${hash}`,
  `/tiles/${hash}`,
  `/archive/templates/${id}`,
  `/archive/tiles/${hash}`,
  '/work?season=3',
  '/work/regions?season=3',
  `/work/${id}/history`,
  '/telemetry/status',
  '/telemetry/alarms',
  '/telemetry/canvas',
  '/telemetry/presence/online',
  '/telemetry/history',
  '/telemetry/painter-history',
  '/telemetry/painters',
  '/telemetry/contributions',
  '/telemetry/leaderboard',
  '/telemetry/tiles/0/0/history',
  `/telemetry/progress/${id}`,
  `/telemetry/templates/${id}/versions/${id}/tiles/0/0/mismatches`,
]
const adminOperations = [
  ['PATCH', '/admin/server'],
  ['GET', '/admin/tokens'],
  ['POST', '/admin/tokens'],
  ['DELETE', `/admin/tokens/${hash}`],
  ['GET', '/admin/nodes'],
  ['POST', '/admin/nodes'],
  ['PATCH', `/admin/nodes/${id}`],
  ['GET', `/admin/nodes/${id}/subtree`],
  ['DELETE', `/admin/nodes/${id}`],
  ['POST', '/admin/templates'],
  ['POST', `/admin/templates/${id}/versions`],
  ['PATCH', `/admin/templates/${id}`],
  ['DELETE', `/admin/templates/${id}`],
  ['DELETE', `/admin/templates/${id}/alarms/${id}`],
  ['GET', '/admin/tags'],
  ['POST', '/admin/tags'],
  ['PATCH', `/admin/tags/${id}`],
  ['DELETE', `/admin/tags/${id}`],
  ['PUT', `/admin/tags/${id}/templates/${id}`],
  ['DELETE', `/admin/tags/${id}/templates/${id}`],
  ['PUT', `/admin/tags/${id}/folders/${id}`],
  ['DELETE', `/admin/tags/${id}/folders/${id}`],
  ['GET', `/admin/backfill/${id}/preview`],
  ['GET', `/admin/backfill/${id}/job`],
  ['POST', `/admin/backfill/${id}/start`],
  ['POST', `/admin/backfill/${id}/cancel`],
] as const
const reportOperations = [
  ['POST', '/telemetry/paints'],
  ['POST', '/telemetry/tiles/offers'],
  ['PUT', `/telemetry/tiles/0/0/${hash}`],
  ['PUT', `/work/${id}`],
  ['PUT', `/work/regions/${id}`],
  ['DELETE', `/work/regions/${id}`],
] as const

afterEach(() => vi.restoreAllMocks())

describe('backend API trust boundary', () => {
  it('requires authentication on every protected read at both API prefixes', async () => {
    const backend = await createTestBackend()
    for (const prefix of ['', '/v1']) {
      for (const path of reads) {
        const response = await request(backend, prefix + path)
        expect(response.status, prefix + path).toBe(401)
        expect(await response.json()).toEqual({ error: 'unauthorized' })
      }
    }
  })

  it('keeps every administration operation inaccessible to read and report credentials', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const read = await mint(backend, 'read')
    const report = await mint(backend, 'report')
    for (const [method, path] of adminOperations) {
      for (const token of [undefined, read.token, report.token]) {
        const response = await request(backend, `/v1${path}`, method, token)
        expect(response.status, `${method} ${path}`).toBe(token === undefined ? 401 : 403)
        expect(await response.json()).toEqual({
          error: token === undefined ? 'unauthorized' : 'forbidden',
        })
      }
    }
  })

  it('keeps every reporting operation inaccessible to anonymous and read-only callers', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const read = await mint(backend, 'read')
    for (const [method, path] of reportOperations) {
      for (const token of [undefined, read.token]) {
        const response = await request(backend, path, method, token)
        expect(response.status, `${method} ${path}`).toBe(token === undefined ? 401 : 403)
      }
    }
  })

  it('supports cross-origin authorization and exposes conditional-read headers to browser clients', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const preflight = await backend.app.fetch(
      new Request('https://backend.test/v1/admin/templates', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://wplace.live',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    )
    const manifest = await request(backend, '/v1/manifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('access-control-expose-headers')).toContain('ETag')
    const etag = manifest.headers.get('etag')
    if (etag === null) throw new Error('manifest omitted its ETag')
    const cached = await backend.app.fetch(
      new Request('https://backend.test/v1/manifest', {
        headers: { 'if-none-match': etag, origin: 'https://wplace.live' },
      }),
    )
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
    expect((await request(backend, '/manifest', 'GET', 'revoked')).status).toBe(401)
  })

  it('rejects malformed read parameters instead of returning a successful empty result', async () => {
    const backend = await createTestBackend()
    const invalid = [
      '/manifest?season=-1',
      '/admin/nodes?season=NaN',
      '/admin/tokens?cursor=invalid',
      `/admin/tags?templateId=${id}&folderId=${id}`,
      '/chunks/not-a-hash',
      '/tiles/not-a-hash',
      '/archive/templates/not-a-uuid',
      '/telemetry/status?season=-1',
      '/telemetry/alarms?season=-1',
      `/telemetry/history?templateIds=${id}&from=10&to=5`,
      `/telemetry/history?templateIds=${id}&from=1&to=2&resolution=60&maxResolution=60`,
      `/telemetry/painter-history?templateIds=${id}&from=1&to=2&painters=bad`,
      `/telemetry/painters?templateIds=${id}&from=1&to=2&limit=0`,
      `/telemetry/contributions?templateIds=${id}&from=2&to=1`,
      '/telemetry/leaderboard?limit=0',
      '/telemetry/canvas?season=-1',
      '/telemetry/tiles/2048/0/history?from=1&to=2',
      `/telemetry/progress/${id}?version=bad&from=1&to=2`,
      `/telemetry/templates/${id}/versions/${id}/tiles/2048/0/mismatches`,
      '/work?season=-1',
      '/work/regions?season=-1',
    ]
    for (const path of invalid) {
      const response = await request(backend, path, 'GET', adminToken)
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toMatchObject({ error: expect.any(String) })
    }
  })

  it('mints and revokes scoped credentials through bootstrap without exposing stored secrets', async () => {
    const backend = await createTestBackend({ bootstrapAdminToken: 'bootstrap-secret' })
    const reader = await mint(backend, 'read', 'bootstrap-secret')
    expect((await request(backend, '/manifest', 'GET', reader.token)).status).toBe(200)
    const listed = await request(backend, '/admin/tokens', 'GET', 'bootstrap-secret')
    const body = (await listed.json()) as { tokens: Record<string, unknown>[] }
    expect(body.tokens).toContainEqual(expect.objectContaining({ bootstrap: true, scope: 'admin' }))
    expect(body.tokens.every((token) => !('token' in token))).toBe(true)
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await request(backend, `/admin/tokens/${reader.tokenHash}`, 'DELETE', 'bootstrap-secret'))
          .status,
      ).toBe(204)
    expect((await request(backend, '/manifest', 'GET', reader.token)).status).toBe(401)
    expect(
      (await request(backend, '/admin/tokens/bootstrap', 'DELETE', 'bootstrap-secret')).status,
    ).toBe(400)
  })

  it('rejects malformed mutations and oversized work requests before changing stored state', async () => {
    const backend = await createTestBackend()
    const invalid: readonly { method: string; path: string; body: unknown }[] = [
      { method: 'PATCH', path: '/admin/server', body: { name: '' } },
      { method: 'POST', path: '/admin/tokens', body: { label: 'Invalid scope', scope: 'owner' } },
      { method: 'POST', path: '/admin/nodes', body: { season: 3, parentId: null, name: '' } },
      { method: 'PATCH', path: `/admin/nodes/${id}`, body: { parentId: 'not-a-uuid' } },
      { method: 'POST', path: '/admin/templates', body: { png: 'a filename is not an upload' } },
      { method: 'PATCH', path: `/admin/templates/${id}`, body: { published: 'true' } },
      { method: 'POST', path: '/admin/tags', body: { name: '\u0000' } },
      { method: 'POST', path: '/telemetry/paints', body: null },
      { method: 'POST', path: '/telemetry/tiles/offers', body: { season: 3, offers: 'invalid' } },
      { method: 'PUT', path: `/work/${id}?season=3`, body: { action: 'unknown' } },
      { method: 'PUT', path: `/work/regions/${id}?season=3`, body: { label: 'Missing geometry' } },
    ]
    for (const { method, path, body } of invalid) {
      const response = await request(backend, path, method, adminToken, body)
      expect(response.status, `${method} ${path}`).toBe(400)
      expect(await response.json()).toMatchObject({ error: expect.any(String) })
    }
    const oversized = await request(
      backend,
      `/work/${id}?season=3`,
      'PUT',
      adminToken,
      'x'.repeat(16_385),
    )
    expect(oversized.status).toBe(413)
    expect(await backend.sql.work.read(id)).toBeNull()
    expect(
      await (await request(backend, '/admin/nodes?season=3', 'GET', adminToken)).json(),
    ).toEqual([])
    expect(await (await request(backend, '/server')).json()).toMatchObject({ name: 'Test server' })
  })

  it('maps storage failures to a non-sensitive HTTP error and permits a later retry', async () => {
    class UnavailableSql extends MemorySqlStore {
      fail = true
      override async readServerSettings() {
        if (this.fail) throw new Error('database password=do-not-expose')
        return super.readServerSettings()
      }
    }
    const sql = new UnavailableSql()
    const backend = await createTestBackend({ sql })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await request(backend, '/server')
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(logged).toHaveBeenCalled()
    sql.fail = false
    expect(await (await request(backend, '/server')).json()).toMatchObject({ name: 'Test server' })
  })

  it('preserves SQLite data on missing or stale destructive preconditions', async () => {
    const store = await openRelationalStore()
    try {
      const backend = await createTestBackend({ sql: store.sql })
      const nodeResponse = await request(backend, '/admin/nodes', 'POST', adminToken, {
        season: 3,
        parentId: null,
        name: 'Collection',
      })
      expect(nodeResponse.status).toBe(201)
      const node = (await nodeResponse.json()) as { id: string }
      const form = new FormData()
      form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'pixel.png'))
      for (const [key, value] of Object.entries({
        nodeId: node.id,
        name: 'Pixel',
        originX: '0',
        originY: '0',
      }))
        form.set(key, value)
      const upload = await backend.app.fetch(
        new Request('https://backend.test/admin/templates', {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}` },
          body: form,
        }),
      )
      expect(upload.status).toBe(201)
      const created = (await upload.json()) as { templateId: string; versionId: string }
      const templatePath = `/admin/templates/${created.templateId}`
      expect((await request(backend, templatePath, 'DELETE', adminToken)).status).toBe(428)
      expect(
        (
          await request(
            backend,
            `${templatePath}?expectedVersion=${created.versionId}&expectedUpdatedAt=0`,
            'DELETE',
            adminToken,
          )
        ).status,
      ).toBe(409)
      expect((await request(backend, `/admin/nodes/${node.id}`, 'DELETE', adminToken)).status).toBe(
        409,
      )
      expect(
        (
          await request(
            backend,
            `/admin/nodes/${node.id}?cascade=true&expectedNodes=1&expectedTemplates=0`,
            'DELETE',
            adminToken,
          )
        ).status,
      ).toBe(409)
      expect(await store.sql.countNodeSubtree(node.id)).toEqual({ nodes: 1, templates: 1 })
      const deleted = await request(
        backend,
        `/admin/nodes/${node.id}?cascade=true&expectedNodes=1&expectedTemplates=1`,
        'DELETE',
        adminToken,
      )
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ nodes: 1, templates: 1, chunks: 0 })
      expect(await store.sql.readTemplate(created.templateId)).toBeNull()
    } finally {
      await store.close()
    }
  })
})
