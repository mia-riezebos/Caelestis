// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAlarms,
  getHistory,
  getServer,
  openLiveSocket,
  patchTemplateLifecycle,
  probeAdminScope,
} from './client.js'

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
  it('opens proxied live reads without putting the Worker token in the browser', () => {
    const sockets: Array<{ url: string; protocols: readonly string[] }> = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: URL, protocols: readonly string[]) {
          sockets.push({ url: String(url), protocols })
        }
      },
    )

    openLiveSocket(7, false)

    expect(sockets[0]?.url).toContain('/api/v1/telemetry/live?season=7&scope=public')
    expect(sockets[0]?.protocols).toEqual(['caelestis.live.v2', 'caelestis.live.v1'])
  })

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
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/server')
  })

  it('probes admin scope without treating an ordinary read token as an app error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
    vi.stubGlobal('fetch', fetch)

    await expect(probeAdminScope(7)).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/admin/nodes?season=7'),
      expect.any(Object),
    )
  })

  it('sends lifecycle mutations and history windows without a client tier', async () => {
    stored.set('caelestis:token', 'browser-admin-token')
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
    expect(historyUrl).toContain('/v1/telemetry/history?')
    expect(historyUrl).toContain('from=10&to=20')
    expect(historyUrl).not.toContain('resolution')
  })

  it('can bound history granularity without naming a decay-ladder tier', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await getHistory(['template'], 10, 20, { maxResolution: 1_800 / 2 })

    const historyUrl = String(fetch.mock.calls[0]?.[0])
    expect(historyUrl).toContain('maxResolution=900')
    expect(historyUrl).not.toMatch(/[?&]resolution=/)
  })

  it('reads active alarms for the selected season', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ alarms: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(getAlarms(7)).resolves.toEqual({ alarms: [] })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/telemetry/alarms?season=7')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('keeps a browser-supplied admin token separate from the Worker read token', async () => {
    stored.set('caelestis:token', 'browser-admin-token')
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ alarms: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await getAlarms(7)

    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:8787/backend/v1/telemetry/alarms?season=7',
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer browser-admin-token',
    )
  })

  it('keeps older self-hosted servers connected through their unversioned API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/server')) return new Response(null, { status: 404 })
      if (url.endsWith('/server')) {
        return Response.json({ id: 'server', name: 'Legacy', auth: 'access_token' })
      }
      return Response.json({ alarms: [] })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(getServer()).resolves.toMatchObject({ name: 'Legacy' })
    await expect(getAlarms(7)).resolves.toEqual({ alarms: [] })
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/v1/server',
      '/api/server',
      '/api/telemetry/alarms?season=7',
    ])
  })
})
