import { describe, expect, it, vi } from 'vitest'
import { meterD1Database, SyncRequestMetrics, syncRoute } from './sync-metrics.js'

const meta = (rowsRead: number, rowsWritten = 0): D1Result<unknown> => ({
  success: true,
  meta: {
    duration: 0,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: rowsWritten,
    last_row_id: 0,
    changed_db: rowsWritten > 0,
    changes: rowsWritten,
  },
  results: [],
})

const fakeStatement = (): D1PreparedStatement =>
  ({
    bind: () => fakeStatement(),
    first: async () => ({ value: 1 }),
    run: async () => meta(7, 2),
    all: async () => meta(7, 2),
    raw: async () => [[1], [2]],
  }) as unknown as D1PreparedStatement

const fakeDatabase = (): D1Database =>
  ({
    prepare: () => fakeStatement(),
    batch: async (statements: D1PreparedStatement[]) => statements.map(() => meta(3, 1)),
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => ({
      prepare: () => fakeStatement(),
      batch: async (statements: D1PreparedStatement[]) => statements.map(() => meta(3, 1)),
      getBookmark: () => null,
    }),
    dump: async () => new ArrayBuffer(0),
  }) as unknown as D1Database

describe('sync request observability', () => {
  it.each([
    ['/manifest?season=7', 'manifest'],
    ['/telemetry/status?season=7', 'status'],
    [
      '/telemetry/templates/template/versions/version/tiles/1/2/mismatches?season=7',
      'mismatch-mask',
    ],
    ['/telemetry/tiles/offers', 'tile-offer'],
    ['/telemetry/tiles/1/2/hash', 'tile-upload'],
    ['/telemetry/paints', 'paint-report'],
    ['/chunks/secret-hash', 'chunk'],
    ['/admin/templates/private-id', 'template-admin'],
  ])('groups %s without logging parameters as %s', (path, route) => {
    expect(syncRoute(new Request(`https://example.com${path}`))).toBe(route)
  })

  it('separates CORS preflights from application routes', () => {
    expect(
      syncRoute(
        new Request('https://example.com/telemetry/status', {
          method: 'OPTIONS',
        }),
      ),
    ).toBe('cors-preflight')
  })

  it('records bounded client dimensions and exact/lower-bound D1 work without secrets', async () => {
    const request = new Request('https://example.com/telemetry/tiles/offers?token=query-secret', {
      method: 'POST',
      headers: {
        authorization: 'Bearer credential-secret',
        'x-caelestis-client': 'userscript',
        'x-caelestis-client-version': '0.5.4',
        'x-caelestis-sync-transport': 'http',
        'x-caelestis-sync-mode': 'compatibility-poll',
        'x-caelestis-sync-reason': 'interval',
      },
    })
    const metrics = new SyncRequestMetrics(request)
    const database = meterD1Database(fakeDatabase(), metrics)
    await database.prepare('select').all()
    await database.prepare('select').raw()
    await database.prepare('select').first()
    await database.batch([database.prepare('one'), database.prepare('two')])
    metrics.recordTileOffer({ requested: 4, accepted: 1, alreadyKnown: 2, rejected: 1 })
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    metrics.finish(new Response(null, { status: 200 }))

    expect(logged).toHaveBeenCalledOnce()
    const event = logged.mock.calls[0]?.[0] as Record<string, unknown>
    expect(event).toMatchObject({
      event: 'caelestis.sync.request',
      route: 'tile-offer',
      method: 'POST',
      status: 200,
      client: 'userscript',
      client_version: '0.5.4',
      sync_transport: 'http',
      sync_mode: 'compatibility-poll',
      sync_reason: 'interval',
      cache_outcome: 'none',
      d1: {
        queries: 5,
        rows_read: 16,
        rows_read_exact: 13,
        rows_read_lower_bound: 3,
        rows_written: 4,
      },
      tile_offer: {
        requested: 4,
        accepted: 1,
        already_known: 2,
        rejected: 1,
        rejected_batches: 0,
        failed_batches: 0,
      },
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('credential-secret')
    expect(serialized).not.toContain('query-secret')
    expect(serialized).not.toContain('secret-hash')
    logged.mockRestore()
  })

  it('collapses invalid cardinality and marks failed offer batches', () => {
    const metrics = new SyncRequestMetrics(
      new Request('https://example.com/telemetry/tiles/offers', {
        headers: {
          'x-caelestis-client': 'attacker-controlled',
          'x-caelestis-client-version': 'not a valid version value',
          'x-caelestis-sync-mode': 'attacker-controlled',
          'x-caelestis-sync-reason': 'attacker-controlled',
        },
      }),
    )
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    metrics.finish(new Response(null, { status: 500 }))

    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      client: 'unknown',
      client_version: 'unknown',
      sync_mode: 'none',
      sync_reason: 'none',
      tile_offer: { failed_batches: 1 },
    })
    logged.mockRestore()
  })

  it('reads simple-request dimensions from the query and rejects unknown valid-looking builds', () => {
    const known = new SyncRequestMetrics(
      new Request(
        'https://example.com/manifest?__caelestis_client=userscript&__caelestis_client_version=0.5.4&__caelestis_sync_transport=http&__caelestis_sync_mode=compatibility-poll&__caelestis_sync_reason=interval',
      ),
    )
    const unknown = new SyncRequestMetrics(
      new Request('https://example.com/manifest', {
        headers: {
          'x-caelestis-client': 'userscript',
          'x-caelestis-client-version': '0.5.5',
        },
      }),
    )
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    known.finish(new Response(null, { status: 304 }))
    unknown.finish(new Response(null, { status: 200 }))

    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      client: 'userscript',
      client_version: '0.5.4',
      sync_mode: 'compatibility-poll',
      sync_reason: 'interval',
      cache_outcome: 'revalidated',
    })
    expect(logged.mock.calls[1]?.[0]).toMatchObject({
      client: 'userscript',
      client_version: 'unknown',
    })
    logged.mockRestore()
  })

  it('counts D1 attempts whose promises reject without inventing row metadata', async () => {
    const source = fakeDatabase()
    source.prepare = () =>
      ({
        ...fakeStatement(),
        all: async () => Promise.reject(new Error('D1 unavailable')),
      }) as unknown as D1PreparedStatement
    const metrics = new SyncRequestMetrics(new Request('https://example.com/health'))
    await expect(meterD1Database(source, metrics).prepare('select').all()).rejects.toThrow(
      'D1 unavailable',
    )
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    metrics.finish(new Response(null, { status: 500 }))

    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      d1: { queries: 1, rows_read: 0, rows_read_exact: 0, rows_written: 0 },
    })
    logged.mockRestore()
  })

  it('keeps structured counts finite when a D1 adapter omits billing metadata', async () => {
    const source = fakeDatabase()
    source.prepare = () =>
      ({
        ...fakeStatement(),
        all: async () => ({ success: true, meta: {}, results: [] }),
      }) as unknown as D1PreparedStatement
    const metrics = new SyncRequestMetrics(new Request('https://example.com/health'))
    await meterD1Database(source, metrics).prepare('select').all()
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    metrics.finish(new Response(null, { status: 200 }))

    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      d1: { queries: 1, rows_read: 0, rows_read_exact: 0, rows_written: 0 },
    })
    logged.mockRestore()
  })
})
