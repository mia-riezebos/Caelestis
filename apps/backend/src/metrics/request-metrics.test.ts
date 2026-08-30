import { clientMetricsAccept } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  instrumentD1,
  measureRequest,
  normalizeMetricRoute,
  recordCacheOutcome,
  recordTileOfferBatch,
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
  })

  it('keeps the capacity traffic classes as separate normalized routes', () => {
    expect(
      [
        ['GET', '/telemetry/status'],
        ['GET', '/manifest'],
        ['POST', '/telemetry/tiles/offers'],
        ['POST', '/telemetry/paints'],
      ].map(([method, path]) => normalizeMetricRoute(method ?? '', path ?? '')),
    ).toEqual([
      'GET /telemetry/status',
      'GET /manifest',
      'POST /telemetry/tiles/offers',
      'POST /telemetry/paints',
    ])
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

  it('keeps concurrent D1 counts in their originating request', async () => {
    const points: AnalyticsEngineDataPoint[] = []
    const dataset = {
      writeDataPoint: (point?: AnalyticsEngineDataPoint) => points.push(point ?? {}),
    }
    const run = (version: string, rows: number) =>
      measureRequest(
        dataset,
        new Request('https://example.com/manifest', {
          headers: {
            accept: clientMetricsAccept({
              client: 'userscript',
              version,
              transport: 'compatibility-poll',
              reason: 'interval',
            }),
          },
        }),
        '/manifest',
        async () => {
          await instrumentD1(database(rows)).prepare('SELECT 1').all()
          return new Response('{}')
        },
      )

    await Promise.all([run('1.0.0', 3), run('2.0.0', 11)])

    expect(
      points
        .map((point) => [point.blobs?.[4], point.doubles?.[2]])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ['1.0.0', 3],
      ['2.0.0', 11],
    ])
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
        return new Response(null, { status: 304 })
      },
    )

    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[7]).toBe('not-modified')
    expect(writeDataPoint.mock.calls[0]?.[0]?.doubles?.slice(2, 6)).toEqual([4, 0, 1, 2])
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
