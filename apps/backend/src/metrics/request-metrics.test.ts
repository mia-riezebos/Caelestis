import { clientMetricsAccept, millis, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import type { TemplateVersionRecord } from '../ports/index.js'
import {
  instrumentD1,
  measureD1Usage,
  measureRequest,
  normalizeMetricClientIdentity,
  normalizeMetricRoute,
  recordCacheOutcome,
  recordLiveTileOfferCacheMetric,
  recordTileOfferBatch,
  recordTileOfferBatchRequested,
} from './request-metrics.js'

const result = (rowsRead: number, rowsWritten = 0): D1Result =>
  ({
    success: true,
    results: [],
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rowsRead,
      rows_written: rowsWritten,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
  }) as D1Result

const statement = (rowsRead: number): D1PreparedStatement =>
  ({
    bind: () => statement(rowsRead),
    first: async () => null,
    run: async () => result(rowsRead),
    all: async () => result(rowsRead),
    raw: async () => [],
  }) as unknown as D1PreparedStatement

const database = (rowsRead: number): D1Database =>
  ({
    prepare: () => statement(rowsRead),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((entry) => entry.run())),
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => {
      throw new Error('unused')
    },
    dump: async () => new ArrayBuffer(0),
  }) as D1Database

describe('request capacity metrics', () => {
  it('never records ids, hashes, or token digests in route dimensions', () => {
    expect(normalizeMetricRoute('DELETE', `/admin/tokens/${'f'.repeat(64)}`)).toBe(
      'DELETE /admin/tokens/:tokenHash',
    )
    expect(normalizeMetricRoute('PUT', `/telemetry/tiles/1/2/${'a'.repeat(64)}`)).toBe(
      'PUT /telemetry/tiles/:x/:y/:hash',
    )
    expect(normalizeMetricRoute('GET', '/untrusted/mia')).toBe('GET other')
    expect(normalizeMetricRoute('mia-is-not-an-http-method', '/manifest')).toBe('OTHER other')
  })

  it('keeps the capacity traffic classes as separate normalized routes', () => {
    expect(
      [
        ['GET', '/telemetry/status'],
        ['GET', '/telemetry/live'],
        ['GET', '/manifest'],
        ['POST', '/telemetry/tiles/offers'],
        ['POST', '/telemetry/paints'],
      ].map(([method, path]) => normalizeMetricRoute(method ?? '', path ?? '')),
    ).toEqual([
      'GET /telemetry/status',
      'GET /telemetry/live',
      'GET /manifest',
      'POST /telemetry/tiles/offers',
      'POST /telemetry/paints',
    ])
  })

  it('records versioned and compatibility paths under the same route dimensions', () => {
    expect(normalizeMetricRoute('GET', '/v1/manifest')).toBe('GET /manifest')
    expect(normalizeMetricRoute('POST', '/v1/telemetry/tiles/offers')).toBe(
      'POST /telemetry/tiles/offers',
    )
    expect(normalizeMetricRoute('GET', '/v1/health')).toBe('GET other')
  })

  it('bounds caller-controlled live client dimensions', () => {
    expect(normalizeMetricClientIdentity('userscript', '0.5.4')).toEqual({
      client: 'userscript',
      clientVersion: '0.5.4',
    })
    expect(normalizeMetricClientIdentity('forged', 'anything')).toEqual({
      client: 'unknown',
      clientVersion: 'unknown',
    })
    expect(normalizeMetricClientIdentity('userscript', 'future')).toEqual({
      client: 'userscript',
      clientVersion: 'unknown',
    })
  })

  it('records route, client, sync, cache, D1 and tile-offer outcomes in fixed columns', async () => {
    const writeDataPoint = vi.fn()
    const request = new Request('https://example.com/telemetry/tiles/offers', {
      method: 'POST',
      headers: {
        accept: clientMetricsAccept({
          client: 'userscript',
          version: '0.5.4',
          transport: 'compatibility-poll',
          reason: 'post-offer',
        }),
      },
    })
    const measured = instrumentD1(database(17))

    const response = await measureRequest(
      { writeDataPoint },
      request,
      '/telemetry/tiles/offers',
      async () => {
        await measured.prepare('SELECT 1').all()
        recordCacheOutcome('hit')
        recordTileOfferBatch({ requested: 4, accepted: 2, alreadyKnown: 1, rejected: 1 })
        return new Response('{}', { status: 200 })
      },
    )

    expect(response.status).toBe(200)
    expect(writeDataPoint).toHaveBeenCalledOnce()
    const point = writeDataPoint.mock.calls[0]?.[0]
    expect(point?.indexes).toEqual(['POST /telemetry/tiles/offers'])
    expect(point?.blobs).toEqual([
      'v1',
      'POST /telemetry/tiles/offers',
      'POST',
      'userscript',
      '0.5.4',
      'compatibility-poll',
      'post-offer',
      'hit',
      'accepted',
      '200',
    ])
    expect(point?.doubles).toEqual([1, expect.any(Number), 17, 0, 1, 0, 4, 2, 1, 1])
  })

  it('records live tile cache operations separately without payload or D1 dimensions', () => {
    const writeDataPoint = vi.fn()

    recordLiveTileOfferCacheMetric(
      { writeDataPoint },
      {
        client: 'userscript',
        clientVersion: '0.5.4',
        cacheOutcome: 'hit',
        requested: 10,
        acknowledged: 10,
        durationMs: 2,
      },
    )

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['WS /telemetry/live:tile-offer-cache'],
      blobs: [
        'v1',
        'WS /telemetry/live:tile-offer-cache',
        'WS',
        'userscript',
        '0.5.4',
        'live',
        'post-offer',
        'hit',
        'already-known',
        '200',
      ],
      doubles: [1, 2, 0, 0, 0, 0, 10, 0, 10, 0],
    })
  })

  it('keeps concurrent D1 counts in their originating request', async () => {
    const points: AnalyticsEngineDataPoint[] = []
    const dataset = {
      writeDataPoint: (point?: AnalyticsEngineDataPoint) => points.push(point ?? {}),
    }
    const run = (reason: 'interval' | 'focus', rows: number) =>
      measureRequest(
        dataset,
        new Request('https://example.com/manifest', {
          headers: {
            accept: clientMetricsAccept({
              client: 'userscript',
              version: '0.5.4',
              transport: 'compatibility-poll',
              reason,
            }),
          },
        }),
        '/manifest',
        async () => {
          await instrumentD1(database(rows)).prepare('SELECT 1').all()
          return new Response('{}')
        },
      )

    await Promise.all([run('interval', 3), run('focus', 11)])

    expect(
      points
        .map((point) => [point.blobs?.[6], point.doubles?.[2]])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ['focus', 11],
      ['interval', 3],
    ])
  })

  it('buckets caller-supplied version labels unless they identify a known build', async () => {
    const writeDataPoint = vi.fn()

    await measureRequest(
      { writeDataPoint },
      new Request('https://example.com/manifest', {
        headers: {
          accept: clientMetricsAccept({
            client: 'userscript',
            version: 'mia-private-token',
            transport: 'compatibility-poll',
            reason: 'interval',
          }),
        },
      }),
      '/manifest',
      async () => new Response('{}'),
    )

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[4]).toBe('unknown')
  })

  it('counts metadata-dropping D1 APIs instead of pretending they read zero rows', async () => {
    const writeDataPoint = vi.fn()
    const measured = instrumentD1(database(4))

    await measureRequest(
      { writeDataPoint },
      new Request('https://example.com/manifest'),
      '/manifest',
      async () => {
        await measured.prepare('SELECT 1').first()
        await measured.prepare('SELECT 1').raw()
        await measured.exec('VACUUM')
        recordCacheOutcome('stale')
        return new Response(null, { status: 304 })
      },
    )

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[7]).toBe('stale')
    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[9]).toBe('304')
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.slice(2, 6)).toEqual([0, 0, 0, 3])
  })

  it('preserves positional raw rows for joined D1 reads with duplicate column names', async () => {
    const sqlite = new SqliteD1Database()
    const store = new D1SqlStore(instrumentD1(sqlite as unknown as D1Database))
    const version: TemplateVersionRecord = {
      templateId: 'template-1',
      surface: WORLD_TEMPLATE_SURFACE,
      season: 1,
      nodeId: null,
      name: 'Template',
      versionId: 'version-1',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(1_000),
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
    }

    try {
      await store.insertTemplateVersion(version)
      await measureRequest(
        undefined,
        new Request('https://example.com/manifest'),
        '/manifest',
        async () => {
          const [listed] = await store.listManifestTemplates(
            { season: 1, surface: WORLD_TEMPLATE_SURFACE },
            true,
          )
          expect(listed).toMatchObject({ id: 'template-1', versionId: 'version-1' })
          return new Response('{}')
        },
      )
    } finally {
      sqlite.close()
    }
  })

  it('counts attempted D1 queries even when the operation rejects', async () => {
    const writeDataPoint = vi.fn()
    const failing = database(0)
    failing.prepare = () =>
      ({
        ...statement(0),
        all: async () => {
          throw new Error('D1 unavailable')
        },
      }) as unknown as D1PreparedStatement

    await expect(
      measureRequest(
        { writeDataPoint },
        new Request('https://example.com/manifest'),
        '/manifest',
        async () => {
          await instrumentD1(failing).prepare('SELECT 1').all()
          return new Response('{}')
        },
      ),
    ).rejects.toThrow('D1 unavailable')

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[9]).toBe('500')
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.slice(2, 6)).toEqual([0, 0, 1, 0])
  })

  it('returns attempted D1 usage with a failed remote operation', async () => {
    const failing = database(0)
    failing.prepare = () =>
      ({
        ...statement(0),
        all: async () => {
          throw new Error('D1 unavailable')
        },
      }) as unknown as D1PreparedStatement

    const measured = await measureD1Usage(async () => {
      await instrumentD1(failing).prepare('SELECT 1').all()
    })

    expect(measured).toMatchObject({
      success: false,
      error: expect.objectContaining({ message: 'D1 unavailable' }),
      usage: { rowsRead: 0, rowsWritten: 0, measuredQueries: 1, unmeasuredQueries: 0 },
    })
  })

  it('keeps a failed tile-offer batch requested count', async () => {
    const writeDataPoint = vi.fn()

    await expect(
      measureRequest(
        { writeDataPoint },
        new Request('https://example.com/telemetry/tiles/offers', { method: 'POST' }),
        '/telemetry/tiles/offers',
        async () => {
          recordTileOfferBatchRequested(3)
          throw new Error('offer processing failed')
        },
      ),
    ).rejects.toThrow('offer processing failed')

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[8]).toBe('failed')
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.[6]).toBe(3)
  })

  it.each([
    {
      expected: 'already-known',
      status: 200,
      counts: { requested: 2, accepted: 0, alreadyKnown: 2, rejected: 0 },
    },
    { expected: 'rejected', status: 400, counts: null },
    { expected: 'failed', status: 500, counts: null },
  ])('classifies $expected tile-offer batches', async ({ expected, status, counts }) => {
    const writeDataPoint = vi.fn()

    await measureRequest(
      { writeDataPoint },
      new Request('https://example.com/telemetry/tiles/offers', { method: 'POST' }),
      '/telemetry/tiles/offers',
      async () => {
        if (counts !== null) recordTileOfferBatch(counts)
        return new Response('{}', { status })
      },
    )

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[8]).toBe(expected)
  })
})
