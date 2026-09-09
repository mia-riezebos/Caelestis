import { beforeEach, describe, expect, it, vi } from 'vitest'

const readBackendJson = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/backend.js', () => ({ readBackendJson }))

import { GET, HEAD } from './+server.js'

const eventFor = (method = 'GET', etag?: string) => {
  const get = vi.fn().mockResolvedValue({
    size: 6,
    httpEtag: '"rev"',
    body: new ReadableStream(),
    arrayBuffer: async () => new TextEncoder().encode('GIF89a').buffer,
  })
  const request = new Request('https://example.com/social/template/art.gif', {
    method,
    headers: etag ? { 'if-none-match': etag } : {},
  })
  const event = {
    request,
    params: { id: 'art' },
    url: new URL(request.url),
    platform: { env: { SOCIAL_IMAGES: { get, head: vi.fn() } } },
  } as unknown as Parameters<typeof GET>[0]
  return { get, event }
}

beforeEach(() =>
  readBackendJson.mockResolvedValue({
    season: 3,
    templates: [{ id: 'art', version: 'v1', published: true }],
  }),
)

describe('public template share images', () => {
  it('serves GIF bytes with the current artwork key and revalidation headers', async () => {
    const { get, event } = eventFor()
    const response = await GET(event)
    expect(get).toHaveBeenCalledWith('social/v1/3/art/v1.gif')
    expect(response.headers.get('content-type')).toBe('image/gif')
    expect(response.headers.get('cache-control')).toBe('public, no-cache')
    expect(await response.text()).toBe('GIF89a')
  })

  it('supports crawler HEAD requests and conditional revalidation without a response body', async () => {
    const head = await HEAD(eventFor('HEAD').event)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const unchanged = await GET(eventFor('GET', '"rev"').event)
    expect(unchanged.status).toBe(304)
  })

  it('checks publication before serving an old URL, even with a matching ETag', async () => {
    readBackendJson.mockResolvedValue({ season: 3, templates: [{ id: 'art', published: false }] })
    const { get, event } = eventFor('GET', '"rev"')
    expect((await GET(event)).status).toBe(404)
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['W/"rev"', '*', '"older", W/"rev"'])(
    'revalidates GET and HEAD with If-None-Match: %s',
    async (etag) => {
      for (const method of ['GET', 'HEAD']) {
        const response = await GET(eventFor(method, etag).event)
        expect(response.status).toBe(304)
        expect(await response.text()).toBe('')
      }
    },
  )

  it('redirects missing previews to the site image without caching the fallback', async () => {
    const { get, event } = eventFor()
    get.mockResolvedValue(null)
    const response = await GET(event)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/social/site.png')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
