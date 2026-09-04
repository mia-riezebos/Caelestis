import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBackend } from './backend.js'

const event = (token?: string) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
  const backendEvent = {
    fetch,
    platform: { env: { CAELESTIS_READ_TOKEN: token } },
    url: new URL('https://caelestis.mia.cx/template/example'),
  } as unknown as Parameters<typeof fetchBackend>[0]
  return {
    fetch,
    event: backendEvent,
  }
}

describe('frontend backend reads', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the Worker read token on the server-side request', async () => {
    const harness = event('worker-read-token')

    await fetchBackend(harness.event, '/v1/manifest')

    expect(harness.fetch).toHaveBeenCalledWith(
      'https://caelestis.mia.cx/backend/v1/manifest',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    const headers = new Headers(harness.fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer worker-read-token')
  })

  it('fails closed when the Worker secret is missing', async () => {
    const harness = event()

    expect(() => fetchBackend(harness.event, '/v1/manifest')).toThrow(
      'missing CAELESTIS_READ_TOKEN',
    )
    expect(harness.fetch).not.toHaveBeenCalled()
  })

  it('uses the existing build-time backend when no runtime override is configured', async () => {
    vi.stubEnv('VITE_CAELESTIS_SERVER', 'https://custom.example/backend/')
    const harness = event('custom-server-read-token')

    await fetchBackend(harness.event, '/v1/manifest')

    expect(harness.fetch).toHaveBeenCalledWith(
      'https://custom.example/backend/v1/manifest',
      expect.any(Object),
    )
  })
})
