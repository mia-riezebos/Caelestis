import { describe, expect, it, vi } from 'vitest'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { DurableObjectStatusReadModel } from './do-status-read-model.js'

describe('Durable Object status read-model adapter', () => {
  it('routes every operation to the season-scoped object', async () => {
    const stub = {
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 4, templates: [] },
      })),
      notifyManifestChange: vi.fn(async () => undefined),
      notifyAlarmChange: vi.fn(async () => undefined),
      closeCredential: vi.fn(async () => undefined),
      fetch: vi.fn(async (_request: Request) => new Response(null, { status: 204 })),
    }
    const namespace = {
      getByName: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<StatusReadModelObject>
    const model = new DurableObjectStatusReadModel(namespace)

    await expect(model.applyCommittedChange(8)).resolves.toBeNull()
    await expect(model.reconcileSnapshot(8, 'admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: { revision: 4, templates: [] },
    })
    await model.notifyManifestChange(8)
    await model.notifyAlarmChange(8)
    await model.closeCredential(8, 'b'.repeat(64))
    await model.connectLive(
      new Request('https://server.test/telemetry/live', {
        headers: {
          authorization: 'Bearer SECRET',
          upgrade: 'websocket',
          'sec-websocket-protocol': 'caelestis.live.v1, caelestis.auth.SECRET',
        },
      }),
      {
        season: 8,
        scope: 'admin',
        tokenHash: 'a'.repeat(64),
        revocable: true,
        lastRevision: 4,
      },
    )

    expect(namespace.getByName).toHaveBeenCalledWith('season:8')
    expect(stub.applyCommittedChange).toHaveBeenCalledWith(8)
    expect(stub.reconcileSnapshot).toHaveBeenCalledWith(8, 'admin')
    expect(stub.notifyManifestChange).toHaveBeenCalledWith(8)
    expect(stub.notifyAlarmChange).toHaveBeenCalledWith(8)
    expect(stub.closeCredential).toHaveBeenCalledWith(8, 'b'.repeat(64))
    const forwarded = stub.fetch.mock.calls[0]?.[0]
    expect(forwarded?.headers.get('authorization')).toBeNull()
    expect(forwarded?.headers.get('x-caelestis-season')).toBe('8')
    expect(forwarded?.headers.get('x-caelestis-scope')).toBe('admin')
    expect(forwarded?.headers.get('x-caelestis-token-hash')).toBe('a'.repeat(64))
    expect(forwarded?.headers.get('x-caelestis-revocable')).toBe('1')
    expect(forwarded?.headers.get('x-caelestis-revision')).toBe('4')
    expect(forwarded?.headers.get('sec-websocket-protocol')).toBe('caelestis.live.v1')
  })
})
