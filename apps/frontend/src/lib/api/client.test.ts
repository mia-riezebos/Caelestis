// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServer } from './client.js'

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
})
