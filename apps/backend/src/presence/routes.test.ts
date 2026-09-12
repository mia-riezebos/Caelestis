import { millis, PRESENCE_PROTOCOL_V1, uuidV7, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'

const setup = async (
  openAccess = false,
  presence: 'enabled' | 'disabled' | 'upgrade-only' = 'enabled',
) => {
  const sql = new MemorySqlStore()
  for (const scope of ['read', 'report'] as const)
    await sql.insertAccessToken({
      tokenHash: await hashToken(scope),
      scope,
      label: scope,
      createdWithToken: 'a'.repeat(64),
      createdAt: millis(Date.now()),
    })
  const connectPresence = vi.fn(async () => new Response('connected'))
  const presenceOnline = vi.fn(async () => 3)
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
    ),
    {
      currentSeason: 0,
      openAccess,
      ...(presence === 'disabled' ? {} : { connectPresence }),
      ...(presence === 'upgrade-only' ? {} : { presenceOnline }),
    },
  )
  const request = (
    query = 'season=0&painterId=1&painterName=Mia',
    protocols = `${PRESENCE_PROTOCOL_V1}, caelestis.auth.b64.${btoa('report')}`,
  ) =>
    app.request(`/v1/telemetry/presence?${query}`, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocols },
    })
  return { app, request, connectPresence, presenceOnline }
}

describe('presence online route', () => {
  it.each([
    ['surface=world', WORLD_TEMPLATE_SURFACE],
    ['surface=alliance-picture&allianceId=7', { kind: 'alliance-picture', allianceId: 7 }],
  ])('returns an uncached headcount for %s with a plain read token', async (query, surface) => {
    const h = await setup()
    const response = await h.app.request(`/v1/telemetry/presence/online?season=0&${query}`, {
      headers: { authorization: 'Bearer read' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ online: 3 })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(h.presenceOnline).toHaveBeenCalledExactlyOnceWith(0, surface)
    expect(h.connectPresence).not.toHaveBeenCalled()
  })

  it('accepts anonymous reads without client identity and exposes the compatibility path', async () => {
    const h = await setup(true)
    h.presenceOnline.mockResolvedValue(0)
    const response = await h.app.request('/telemetry/presence/online?season=0')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ online: 0 })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(h.presenceOnline).toHaveBeenCalledExactlyOnceWith(0, WORLD_TEMPLATE_SURFACE)
    expect(h.connectPresence).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'upgrade-only'] as const)(
    'returns 404 when presence is %s',
    async (mode) => {
      const h = await setup(true, mode)
      const response = await h.app.request('/v1/telemetry/presence/online?season=0&surface=world')
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not found' })
      expect(h.presenceOnline).not.toHaveBeenCalled()
    },
  )

  it('rejects unserved seasons and invalid drawing scopes before reading the room', async () => {
    const h = await setup(true)
    for (const query of ['', 'season=1', 'season=bad'])
      expect((await h.app.request(`/v1/telemetry/presence/online?${query}`)).status).toBe(404)
    for (const query of [
      'surface=bad',
      'surface=alliance-picture',
      'surface=alliance-picture&allianceId=0',
      'surface=world&allianceId=bad',
      'surface=world&allianceId=-1',
      'surface=world&allianceId=1.5',
    ])
      expect((await h.app.request(`/v1/telemetry/presence/online?season=0&${query}`)).status).toBe(
        400,
      )
    expect(h.presenceOnline).not.toHaveBeenCalled()
  })

  it('requires read authentication and rejects invalid tokens even on an open server', async () => {
    const closed = await setup()
    expect((await closed.app.request('/v1/telemetry/presence/online?season=0')).status).toBe(401)
    const open = await setup(true)
    expect(
      (
        await open.app.request('/v1/telemetry/presence/online?season=0', {
          headers: { authorization: 'Bearer bad' },
        })
      ).status,
    ).toBe(401)
    expect(closed.presenceOnline).not.toHaveBeenCalled()
    expect(open.presenceOnline).not.toHaveBeenCalled()
  })
})

describe('presence upgrade route', () => {
  it('authenticates the protocol token, forwards identity and metrics, and advertises presence', async () => {
    const h = await setup()
    expect(
      (
        await h.request(
          'season=0&painterId=1&painterName=Mia%20%F0%9F%8E%A8&client=userscript&clientVersion=1.2.3',
        )
      ).status,
    ).toBe(200)
    expect(h.connectPresence).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        season: 0,
        surface: WORLD_TEMPLATE_SURFACE,
        painter: { wplaceUserId: 1, displayName: 'Mia 🎨' },
        credentialScope: 'report',
        tokenHash: await hashToken('report'),
        anonymous: false,
        revocable: true,
        metricClient: 'userscript',
        metricClientVersion: 'unknown',
      }),
    )
    expect(await (await h.app.request('/server')).json()).toMatchObject({ presence: 1 })
  })
  it('rejects wrong season, surface, identity, protocol, and credential', async () => {
    const h = await setup()
    expect((await h.request('season=1&painterId=1&painterName=Mia')).status).toBe(404)
    for (const query of [
      'season=0&painterId=-1&painterName=Mia',
      'season=0&painterId=1&painterName=',
      'season=0&painterId=1&painterName=Mia&allianceId=bad',
      'season=0&painterId=1&painterName=Mia&surface=alliance-picture',
    ])
      expect((await h.request(query)).status).toBe(400)
    expect((await h.request(undefined, 'caelestis.live.v1')).status).toBe(400)
    expect(
      (await h.request(undefined, `${PRESENCE_PROTOCOL_V1}, caelestis.auth.b64.YmFk`)).status,
    ).toBe(401)
    expect(h.connectPresence).not.toHaveBeenCalled()
  })
  it('requires a UUID client identity for anonymous observers and retains read scope', async () => {
    const h = await setup(true)
    expect((await h.request(undefined, PRESENCE_PROTOCOL_V1)).status).toBe(400)
    expect(
      (
        await h.request(
          `season=0&painterId=1&painterName=Mia&clientId=${uuidV7()}`,
          PRESENCE_PROTOCOL_V1,
        )
      ).status,
    ).toBe(200)
    expect(h.connectPresence).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ credentialScope: 'read', anonymous: true, revocable: false }),
    )
  })
})
