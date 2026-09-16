import { afterEach, expect, it, vi } from 'vitest'

const id = '018f1b8c-7f4e-7a8c-8a01-123456789abc'
const manifest = {
  version: id,
  season: 1,
  server: { id, name: 'Open', auth: 'none' },
  nodes: [],
  templates: [],
  tiles: [],
}

afterEach(() => vi.unstubAllGlobals())

it('retries rejected credentials anonymously and keeps admin controls unavailable', async () => {
  const requests: { path: string; token: string | null }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const token = new Headers(init?.headers).get('authorization')
    requests.push({ path, token })
    if (path === '/backend/v1/server') return Response.json(manifest.server)
    if (path === '/backend/v1/manifest') {
      return token === null
        ? Response.json(manifest)
        : Response.json({ error: 'revoked' }, { status: 403 })
    }
    if (path === '/backend/v1/admin/nodes') return new Response(null, { status: 403 })
    throw new Error(`Unexpected request ${path}`)
  })
  const { probeServer } = await import('../src/state.js')
  const server = await probeServer('https://open.test', 'stale')
  expect(server.error).toBeUndefined()
  expect(server).toMatchObject({
    status: 'connected',
    tokenUsable: false,
    isAdmin: false,
    season: 1,
  })
  expect(requests).toEqual([
    { path: '/backend/v1/server', token: 'Bearer stale' },
    { path: '/backend/v1/manifest', token: 'Bearer stale' },
    { path: '/backend/v1/manifest', token: null },
    { path: '/backend/v1/admin/nodes', token: null },
  ])
})
