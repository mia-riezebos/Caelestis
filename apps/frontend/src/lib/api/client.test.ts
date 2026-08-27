// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHistory, getServer, patchTemplateLifecycle, probeAdminScope } from './client.js'

const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API request recovery', () => {
  it('retries one transient server failure before failing template loading', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Temporary server failure' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'server',
            name: 'Caelestis',
            auth: 'access_token',
            description: 'Templates',
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)

    await expect(getServer()).resolves.toMatchObject({ id: 'server', name: 'Caelestis' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('probes admin scope without treating an ordinary read token as an app error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
    vi.stubGlobal('fetch', fetch)

    await expect(probeAdminScope(7)).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/admin/nodes?season=7'),
      expect.any(Object),
    )
  })

  it('sends lifecycle mutations and history windows without a client tier', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes('/telemetry/history')) {
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      }
      expect(init).toMatchObject({
        method: 'PATCH',
        body: JSON.stringify({ finished: true }),
      })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)

    await patchTemplateLifecycle('template', { finished: true })
    await getHistory(['template'], 10, 20)
    const historyUrl = String(fetch.mock.calls[1]?.[0])
    expect(historyUrl).toContain('from=10&to=20')
    expect(historyUrl).not.toContain('resolution')
  })
})
