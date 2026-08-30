import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestServerManifest, requestServerMetadata } from './server-transport.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server request observability', () => {
  it('attributes ordinary userscript requests without leaking request data into dimensions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)

    await requestServerMetadata('https://example.com/server', {
      headers: { authorization: 'Bearer secret' },
    })

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(headers.get('x-caelestis-client')).toBe('userscript')
    expect(headers.get('x-caelestis-client-version')).toBe('development')
    expect(headers.get('x-caelestis-sync-mode')).toBe('none')
    expect(headers.get('x-caelestis-sync-reason')).toBe('none')
  })

  it('labels compatibility manifest polling separately', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)

    await requestServerManifest('https://example.com/manifest', {}, undefined, {
      mode: 'compatibility-poll',
      reason: 'interval',
    })

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-caelestis-sync-transport')).toBe('http')
    expect(headers.get('x-caelestis-sync-mode')).toBe('compatibility-poll')
    expect(headers.get('x-caelestis-sync-reason')).toBe('interval')
  })
})
