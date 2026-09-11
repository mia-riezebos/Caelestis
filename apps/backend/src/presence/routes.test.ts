import { millis, PRESENCE_PROTOCOL_V1, uuidV7, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'

const setup = async (openAccess = false) => {
  const sql = new MemorySqlStore()
  await sql.insertAccessToken({
    tokenHash: await hashToken('report'),
    scope: 'report',
    label: 'report',
    createdWithToken: 'a'.repeat(64),
    createdAt: millis(Date.now()),
  })
  const connectPresence = vi.fn(async () => new Response('connected'))
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
    ),
    { currentSeason: 0, openAccess, connectPresence },
  )
  const request = (
    query = 'season=0&painterId=1&painterName=Mia',
    protocols = `${PRESENCE_PROTOCOL_V1}, caelestis.auth.b64.${btoa('report')}`,
  ) =>
    app.request(`/v1/telemetry/presence?${query}`, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocols },
    })
  return { app, request, connectPresence }
}

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
