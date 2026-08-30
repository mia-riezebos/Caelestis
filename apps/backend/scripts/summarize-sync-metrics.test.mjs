import { expect, test } from 'vitest'
import { parseTail, summarizeSyncEvents } from './summarize-sync-metrics.mjs'

test('summarizes direct and Wrangler-wrapped structured sync events', () => {
  const first = {
    event: 'caelestis.sync.request',
    route: 'status',
    client: 'userscript',
    client_version: '0.5.4',
    sync_mode: 'compatibility-poll',
    cache_outcome: 'miss',
    d1: {
      queries: 2,
      rows_read: 8,
      rows_read_exact: 6,
      rows_read_lower_bound: 2,
      rows_written: 0,
    },
  }
  const second = {
    event: 'caelestis.sync.request',
    route: 'tile-offer',
    client: 'userscript',
    client_version: '0.5.4',
    sync_mode: 'none',
    cache_outcome: 'none',
    d1: {
      queries: 1,
      rows_read: 3,
      rows_read_exact: 3,
      rows_read_lower_bound: 0,
      rows_written: 1,
    },
    tile_offer: {
      requested: 4,
      accepted: 1,
      already_known: 2,
      rejected: 1,
      rejected_batches: 0,
      failed_batches: 0,
    },
  }
  const input = [
    JSON.stringify(first),
    JSON.stringify({ logs: [{ level: 'log', message: [JSON.stringify(second)] }] }),
    JSON.stringify({
      event: 'caelestis.sync.request',
      route: 'cors-preflight',
      client: 'unknown',
      client_version: 'unknown',
    }),
    'not json',
  ].join('\n')

  const summary = summarizeSyncEvents(parseTail(input))

  expect(summary.invocations).toBe(3)
  expect(summary.requests).toBe(2)
  expect(summary.preflights).toBe(1)
  expect(summary.by_route).toEqual({ status: 1, 'tile-offer': 1 })
  expect(summary.by_route_client_version).toEqual({
    'status|userscript@0.5.4': 1,
    'tile-offer|userscript@0.5.4': 1,
  })
  expect(summary.d1).toEqual({
    queries: 3,
    rows_read: 11,
    rows_read_exact: 9,
    rows_read_lower_bound: 2,
    rows_written: 1,
  })
  expect(summary.tile_offer.requested).toBe(4)
  expect(summary.tile_offer.already_known).toBe(2)
})
