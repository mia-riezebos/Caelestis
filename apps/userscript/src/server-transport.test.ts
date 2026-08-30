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

    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.has('x-caelestis-client')).toBe(false)
    expect(url.searchParams.get('__caelestis_client')).toBe('userscript')
    expect(url.searchParams.get('__caelestis_client_version')).toBe('development')
    expect(url.searchParams.get('__caelestis_sync_transport')).toBe('http')
    expect(url.searchParams.get('__caelestis_sync_mode')).toBe('compatibility-poll')
    expect(url.searchParams.get('__caelestis_sync_reason')).toBe('interval')
  })
})
