import { describe, expect, it, vi } from 'vitest'
import { measureRequest } from '../../metrics/request-metrics.js'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { DurableObjectStatusReadModel } from './do-status-read-model.js'

describe('Durable Object status read-model adapter', () => {
  it('routes every operation to the season-scoped object', async () => {
    const stub = {
      applyCommittedChangeMeasured: vi.fn(async () => ({
        success: true as const,
        value: null,
        usage: { rowsRead: 0, rowsWritten: 0, measuredQueries: 0, unmeasuredQueries: 0 },
      })),
      reconcileSnapshotMeasured: vi.fn(async () => ({
        success: true as const,
        value: {
          cacheOutcome: 'hit' as const,
          snapshot: { revision: 4, templates: [] },
        },
        usage: { rowsRead: 0, rowsWritten: 0, measuredQueries: 0, unmeasuredQueries: 0 },
      })),
      notifyManifestChange: vi.fn(async () => undefined),
      notifyAlarmChange: vi.fn(async () => undefined),
      closeCredential: vi.fn(async () => undefined),
      prepareTileGenerationCommit: vi.fn(async () => ({
        coverageToken: 'coverage-token',
        commitToken: 'commit-token',
      })),
      finishTileGenerationCommit: vi.fn(async () => undefined),
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
    await expect(model.prepareTileGenerationCommit(8, { x: 1, y: 2 })).resolves.toEqual({
      coverageToken: 'coverage-token',
      commitToken: 'commit-token',
    })
    await model.finishTileGenerationCommit(
      8,
      { x: 1, y: 2 },
      {
        coverageToken: 'coverage-token',
        commitToken: 'commit-token',
      },
    )
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
        credentialScope: 'admin',
        tokenHash: 'a'.repeat(64),
        revocable: true,
        lastRevision: 4,
      },
    )

    expect(namespace.getByName).toHaveBeenCalledWith('season:8')
    expect(stub.applyCommittedChangeMeasured).toHaveBeenCalledWith(8)
    expect(stub.reconcileSnapshotMeasured).toHaveBeenCalledWith(8, 'admin')
    expect(stub.notifyManifestChange).toHaveBeenCalledWith(8)
    expect(stub.notifyAlarmChange).toHaveBeenCalledWith(8)
    expect(stub.closeCredential).toHaveBeenCalledWith(8, 'b'.repeat(64))
    expect(stub.prepareTileGenerationCommit).toHaveBeenCalledWith(8, { x: 1, y: 2 })
    expect(stub.finishTileGenerationCommit).toHaveBeenCalledWith(
      8,
      { x: 1, y: 2 },
      { coverageToken: 'coverage-token', commitToken: 'commit-token' },
    )
    const forwarded = stub.fetch.mock.calls[0]?.[0]
    expect(forwarded?.headers.get('authorization')).toBeNull()
    expect(forwarded?.headers.get('x-caelestis-season')).toBe('8')
    expect(forwarded?.headers.get('x-caelestis-scope')).toBe('admin')
    expect(forwarded?.headers.get('x-caelestis-token-hash')).toBe('a'.repeat(64))
    expect(forwarded?.headers.get('x-caelestis-revocable')).toBe('1')
    expect(forwarded?.headers.get('x-caelestis-revision')).toBe('4')
    expect(forwarded?.headers.get('sec-websocket-protocol')).toBe('caelestis.live.v1')
  })

  it('merges projection D1 usage into the originating request metric', async () => {
    const stub = {
      reconcileSnapshotMeasured: vi.fn(async () => ({
        success: true as const,
        value: {
          cacheOutcome: 'miss' as const,
          snapshot: { revision: 1, templates: [] },
        },
        usage: { rowsRead: 17, rowsWritten: 2, measuredQueries: 3, unmeasuredQueries: 4 },
      })),
    }
    const namespace = {
      getByName: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<StatusReadModelObject>
    const model = new DurableObjectStatusReadModel(namespace)
    const writeDataPoint = vi.fn()

    await measureRequest(
      { writeDataPoint },
      new Request('https://server.test/telemetry/status'),
      '/telemetry/status',
      async () => {
        await model.reconcileSnapshot(8, 'public')
        return Response.json({ templates: [] })
      },
    )

    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.slice(2, 6)).toEqual([17, 2, 3, 4])
  })

  it('merges projection D1 usage before rethrowing a failed RPC outcome', async () => {
    const error = new Error('projection unavailable')
    const stub = {
      reconcileSnapshotMeasured: vi.fn(async () => ({
        success: false as const,
        error,
        usage: { rowsRead: 0, rowsWritten: 0, measuredQueries: 2, unmeasuredQueries: 1 },
      })),
    }
    const namespace = {
      getByName: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<StatusReadModelObject>
    const model = new DurableObjectStatusReadModel(namespace)
    const writeDataPoint = vi.fn()

    await expect(
      measureRequest(
        { writeDataPoint },
        new Request('https://server.test/telemetry/status'),
        '/telemetry/status',
        async () => {
          await model.reconcileSnapshot(8, 'public')
          return Response.json({ templates: [] })
        },
      ),
    ).rejects.toBe(error)

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[9]).toBe('500')
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.slice(2, 6)).toEqual([0, 0, 2, 1])
  })
})
