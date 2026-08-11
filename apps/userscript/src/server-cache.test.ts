import { afterEach, describe, expect, it, vi } from 'vitest'

const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'

afterEach(() => {
  vi.doUnmock('./state.js')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('server cache persistence', () => {
  it('fails a blocked upgrade and closes a connection that succeeds too late', async () => {
    const database = { close: vi.fn() } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    const open = vi.fn(() => opening)
    vi.stubGlobal('indexedDB', { open })
    const { loadServerCache } = await import('./server-cache.js')

    const loading = loadServerCache(['https://example.com'])
    opening.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
    await expect(loading).resolves.toEqual([])
    expect(open).toHaveBeenCalledWith('caelestis', 3)

    opening.onsuccess?.(new Event('success'))
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('reads only configured servers sequentially, validates them, and closes the database', async () => {
    const entries: Record<string, unknown> = {
      'https://example.com': {
        url: 'https://example.com',
        serverId: SERVER_ID,
        season: 0,
        fetchedAt: 10,
        nodes: [
          {
            id: NODE_ID,
            parentId: null,
            path: '/group',
            name: 'Group',
            createdAt: 1_750_000_000_000,
          },
        ],
      },
      'https://bad.example.com': {
        url: 'https://bad.example.com',
        serverId: SERVER_ID,
        season: 0,
        fetchedAt: 20,
        nodes: [
          {
            id: NODE_ID,
            parentId: NODE_ID,
            path: '/loop',
            name: 'Loop',
            createdAt: 1_750_000_000_000,
          },
        ],
      },
      'https://stale.example.com': { url: 'https://stale.example.com' },
    }
    const requests = new Map<string, IDBRequest<unknown>>()
    const get = vi.fn((url: string) => {
      const request = { result: entries[url] } as unknown as IDBRequest<unknown>
      requests.set(url, request)
      return request
    })
    const store = { get }
    const transaction = { objectStore: vi.fn(() => store) } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadServerCache } = await import('./server-cache.js')
    let settled = false

    const loading = loadServerCache([
      'https://example.com',
      'https://bad.example.com',
      'https://example.com',
    ]).then((value) => {
      settled = true
      return value
    })
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)
    requests.get('https://example.com')?.onsuccess?.(new Event('success'))
    expect(get).toHaveBeenCalledTimes(2)
    requests.get('https://bad.example.com')?.onsuccess?.(new Event('success'))
    await Promise.resolve()
    expect(settled).toBe(false)

    transaction.oncomplete?.(new Event('complete'))
    await expect(loading).resolves.toEqual([
      {
        url: 'https://example.com',
        serverId: SERVER_ID,
        season: 0,
        fetchedAt: 10,
        nodes: [
          {
            id: NODE_ID,
            parentId: null,
            path: '/group',
            name: 'Group',
            createdAt: 1_750_000_000_000,
          },
        ],
      },
    ])
    expect(database.close).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).not.toHaveBeenCalledWith('https://stale.example.com')
  })

  it('stops reading before later records can exceed the aggregate node budget', async () => {
    vi.doMock('./state.js', () => ({
      MAX_TREE_NODES: 2,
      validateTreeNodes: vi.fn((value: unknown) => (Array.isArray(value) ? value : null)),
    }))
    const first = {
      url: 'https://first.example.com',
      serverId: SERVER_ID,
      season: 0,
      fetchedAt: 10,
      nodes: [{ id: 'one' }, { id: 'two' }],
    }
    const requests = new Map<string, IDBRequest<unknown>>()
    const get = vi.fn((url: string) => {
      const request = {
        result: url === first.url ? first : { ...first, url },
      } as unknown as IDBRequest<unknown>
      requests.set(url, request)
      return request
    })
    const store = { get }
    const transaction = { objectStore: vi.fn(() => store) } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadServerCache } = await import('./server-cache.js')

    const loading = loadServerCache([first.url, 'https://second.example.com'])
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    requests.get(first.url)?.onsuccess?.(new Event('success'))

    expect(get).toHaveBeenCalledTimes(1)
    transaction.oncomplete?.(new Event('complete'))
    await expect(loading).resolves.toEqual([first])
    expect(database.close).toHaveBeenCalledOnce()
  })
})
