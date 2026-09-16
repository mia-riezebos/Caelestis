import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

it('keeps a newer delta when an older snapshot arrives and rejects a retired connection', async () => {
  vi.useFakeTimers()
  const state = await import('../src/state.js')
  const sync = await import('../src/server-sync-coordinator.js')
  const server = {
    url: 'https://revision.test',
    info: { id: '018f4f2a-1234-7abc-8def-0123456789ab', name: 'Revision', auth: 'none' as const },
    token: null,
    status: 'connected' as const,
    isAdmin: false,
    season: 1,
  }
  state.upsertServer(server)
  let rows = ['initial']
  expect(
    sync.applyServerSyncSnapshot(
      server,
      'world',
      'catalog',
      undefined,
      { status: 'changed', revision: '1' },
      () => {
        rows = ['snapshot']
      },
    ),
  ).toBe('applied')
  expect(
    sync.applyServerSyncDelta(server, 'world', 'catalog', '1', '2', () => {
      rows = ['delta']
    }),
  ).toBe('applied')
  expect(
    sync.applyServerSyncSnapshot(
      server,
      'world',
      'catalog',
      '1',
      { status: 'changed', revision: '1' },
      () => {
        rows = ['stale snapshot']
      },
    ),
  ).toBe('stale')
  expect(
    sync.applyServerSyncDelta(server, 'world', 'catalog', '1', '2', () => {
      rows = ['duplicate']
    }),
  ).toBe('duplicate')
  expect(
    sync.applyServerSyncDelta(server, 'world', 'catalog', '3', '4', () => {
      rows = ['gap']
    }),
  ).toBe('reconcile')
  expect(rows).toEqual(['delta'])
  state.removeServer(server.url)
  state.upsertServer({ ...server, token: 'replacement' })
  expect(
    sync.applyServerSyncDelta(server, 'world', 'catalog', '2', '3', () => {
      rows = ['retired']
    }),
  ).toBe('stale-connection')
  expect(rows).toEqual(['delta'])
  state.removeServer(server.url)
})
