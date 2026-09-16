import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import type { RequestEvent } from '@sveltejs/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBackend } from '../lib/server/backend'
import { socialMetadata } from '../lib/server/social'
import { socialImageKey } from '../lib/social-image'
import { load } from '../routes/+layout.server'
import { GET as proxy } from '../routes/api/[...path]/+server'
import { GET as imageGet, HEAD as imageHead } from '../routes/social/template/[id].gif/+server'
import { adminToken, createTestBackend } from './backend'
import { manifest, template } from './fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const requestEvent = (url: string, fetcher: typeof fetch, init: RequestInit = {}) =>
  ({
    url: new URL(url),
    request: new Request(url, init),
    fetch: fetcher,
    locals: {
      backendEnvironment: {
        CAELESTIS_SERVER: 'https://backend.test',
        CAELESTIS_READ_TOKEN: adminToken,
      },
    },
    params: {},
    platform: undefined,
    route: { id: null },
    cookies: {
      get: () => undefined,
      getAll: () => [],
      set: () => {
        throw new Error('unexpected cookie mutation')
      },
      delete: () => {
        throw new Error('unexpected cookie mutation')
      },
      serialize: () => {
        throw new Error('unexpected cookie serialization')
      },
    },
    getClientAddress: () => '127.0.0.1',
    setHeaders: () => {
      throw new Error('unexpected response header mutation')
    },
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    get tracing(): never {
      throw new Error('unexpected tracing access')
    },
  }) satisfies RequestEvent

describe('server-side read boundaries', () => {
  it('uses the server credential, strips cookies, and honors portable environment configuration', async () => {
    const { app } = await createTestBackend()
    const requests: Request[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return app.fetch(request)
    }
    const event = requestEvent('https://frontend.test/', fetcher)
    const response = await fetchBackend(event, '/v1/manifest', {
      headers: { cookie: 'session=private', authorization: 'Bearer browser-token' },
    })
    expect(response.status).toBe(200)
    expect(requests[0].headers.get('cookie')).toBeNull()
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${adminToken}`)
    expect(requests[0].headers.get('accept')).toContain('frontend')
  })

  it('proxy forwards conditional reads but removes headers describing compressed upstream bytes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"version"')
      return new Response('decoded', {
        headers: { 'content-encoding': 'gzip', 'content-length': '999', etag: '"version"' },
      })
    })
    const event = requestEvent('https://frontend.test/api/v1/server', fetcher, {
      headers: { 'if-none-match': '"version"', cookie: 'private' },
    })
    const response = await proxy(
      Object.assign(event, {
        params: { path: 'v1/server' },
        route: { id: '/api/[...path]' as const },
      }),
    )
    expect(await response.text()).toBe('decoded')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('etag')).toBe('"version"')
  })

  it('SSR keeps a useful manifest when optional telemetry fails and marks recovery', async () => {
    const { app } = await createTestBackend()
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url.includes('/telemetry/status')) return new Response(null, { status: 503 })
      return app.fetch(request)
    }
    const result = await load(
      Object.assign(requestEvent('https://frontend.test/', fetcher), {
        route: { id: '/' as const },
        parent: async () => ({}),
        depends: () => {},
        untrack: <T>(fn: () => T) => fn(),
      }),
    )
    expect(result?.bootstrap.manifest?.season).toBe(3)
    expect(result?.bootstrap.needsRecovery).toBe(true)
    expect(result?.bootstrap.error).toBeNull()
    expect(result?.social.image).toContain('/social/site.png')
  })
})

describe('public social metadata and stored image routes', () => {
  it('only published templates receive template metadata and strips private query parameters', async () => {
    const data = manifest()
    const context = { server: data.server, manifest: data, statuses: [] }
    const url = new URL(`https://frontend.test/template/${template().id}?token=private`)
    const metadata = await socialMetadata(url, context)
    expect(metadata.title).toBe('Artwork · Test world')
    expect(metadata.url).not.toContain('?')
    const hidden = await socialMetadata(url, {
      ...context,
      manifest: manifest({ templates: [template({ published: false })] }),
    })
    expect(hidden.title).toBe('Test world · Caelestis')
    expect(
      (await socialMetadata(new URL('https://frontend.test/template/%ZZ'), context)).imageType,
    ).toBe('image/png')
  })

  it('revalidates publication even for conditional requests and serves HEAD without a body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-social-'))
    const objects = new FilesystemObjectStorage(directory)
    try {
      const data = manifest()
      const info = await objects.put(socialImageKey(1, template()), new Uint8Array([71, 73, 70]), {
        contentType: 'image/gif',
      })
      let published = true
      const fetcher: typeof fetch = async (input) => {
        expect(String(input)).toBe('https://backend.test/v1/manifest')
        return Response.json(published ? data : manifest({ templates: [] }))
      }
      const event = Object.assign(
        requestEvent(`https://frontend.test/social/template/${template().id}.gif`, fetcher),
        {
          params: { id: template().id },
          route: { id: '/social/template/[id].gif' as const },
          locals: {
            objectStorage: objects,
            backendEnvironment: {
              CAELESTIS_SERVER: 'https://backend.test',
              CAELESTIS_READ_TOKEN: adminToken,
            },
          },
        },
      )
      const get = await imageGet(event)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([71, 73, 70]))
      expect(get.headers.get('cache-control')).toBe('public, no-cache')
      event.request = new Request(event.url, { method: 'HEAD' })
      const head = await imageHead(event)
      expect(await head.text()).toBe('')
      event.request = new Request(event.url, { headers: { 'if-none-match': `W/"${info?.etag}"` } })
      expect((await imageGet(event)).status).toBe(304)
      published = false
      expect((await imageGet(event)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
