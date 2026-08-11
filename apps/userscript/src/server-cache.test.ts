import { afterEach, describe, expect, it, vi } from 'vitest'

const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'

afterEach(() => {
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

    const loading = loadServerCache()
    opening.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
    await expect(loading).resolves.toEqual([])
    expect(open).toHaveBeenCalledWith('caelestis', 3)

    opening.onsuccess?.(new Event('success'))
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('returns only validated trees after the read transaction commits and closes the database', async () => {
    const request = {
      result: [
        {
          url: 'https://example.com',
          fetchedAt: 10,
          nodes: [{ id: NODE_ID, parentId: null, path: '/group', name: 'Group' }],
        },
        {
          url: 'https://bad.example.com',
          fetchedAt: 20,
          nodes: [{ id: NODE_ID, parentId: NODE_ID, path: '/loop', name: 'Loop' }],
        },
      ],
    } as unknown as IDBRequest<unknown[]>
    const store = { getAll: vi.fn(() => request) }
    const transaction = { objectStore: vi.fn(() => store) } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadServerCache } = await import('./server-cache.js')
    let settled = false

    const loading = loadServerCache().then((value) => {
      settled = true
      return value
    })
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    await Promise.resolve()
    expect(settled).toBe(false)

    transaction.oncomplete?.(new Event('complete'))
    await expect(loading).resolves.toEqual([
      {
        url: 'https://example.com',
        fetchedAt: 10,
        nodes: [{ id: NODE_ID, parentId: null, path: '/group', name: 'Group' }],
      },
    ])
    expect(database.close).toHaveBeenCalledOnce()
  })
})
