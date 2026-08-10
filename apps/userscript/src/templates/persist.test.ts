import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('local template persistence', () => {
  it('resolves a write only after its IndexedDB transaction commits', async () => {
    const request = {} as IDBRequest<unknown>
    const transaction = {
      objectStore: vi.fn(() => ({ put: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { saveTemplate } = await import('./persist.js')
    let settled = false

    const saving = saveTemplate({
      id: 'test',
      name: 'Test',
      source: 'image',
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
      moved: 0,
      opaque: 1,
      visible: true,
      everPlaced: true,
    }).then(() => {
      settled = true
    })
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    await Promise.resolve()

    expect(settled).toBe(false)
    transaction.oncomplete?.(new Event('complete'))
    await saving
    expect(settled).toBe(true)
  })

  it('reports a transaction abort as a failed durable write and closes the database', async () => {
    const request = {} as IDBRequest<unknown>
    const transaction = {
      objectStore: vi.fn(() => ({ put: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { saveTemplate } = await import('./persist.js')

    const saving = saveTemplate({
      id: 'test',
      name: 'Test',
      source: 'image',
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
      moved: 0,
      opaque: 1,
      visible: true,
      everPlaced: true,
    })
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    transaction.onabort?.(new Event('abort'))

    await expect(saving).resolves.toBe(false)
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('waits for durable deletes and stops loading before the aggregate pixel cap', async () => {
    const deleteRequest = {} as IDBRequest<undefined>
    const cursor = {
      value: { id: 'loaded', name: 'Loaded', indices: new Uint8Array([0, 1]) },
      continue: vi.fn(),
    }
    const loadRequest = { result: cursor } as unknown as IDBRequest<IDBCursorWithValue | null>
    const deleteStore = { delete: vi.fn(() => deleteRequest) }
    const loadStore = { openCursor: vi.fn(() => loadRequest) }
    const deleteTransaction = {
      objectStore: vi.fn(() => deleteStore),
    } as unknown as IDBTransaction
    const loadTransaction = {
      objectStore: vi.fn(() => loadStore),
    } as unknown as IDBTransaction
    const databases = [
      {
        transaction: vi.fn(() => deleteTransaction),
        close: vi.fn(),
      },
      {
        transaction: vi.fn(() => loadTransaction),
        close: vi.fn(),
      },
    ] as unknown as IDBDatabase[]
    const deleteOpening = { result: databases[0] } as IDBOpenDBRequest
    const loadOpening = { result: databases[1] } as IDBOpenDBRequest
    const openingQueue = [deleteOpening, loadOpening]
    vi.stubGlobal('indexedDB', { open: vi.fn(() => openingQueue.shift()) })
    const { deleteTemplate, loadTemplates } = await import('./persist.js')

    const deleting = deleteTemplate('gone')
    deleteOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    deleteRequest.onsuccess?.(new Event('success'))
    deleteTransaction.oncomplete?.(new Event('complete'))
    await expect(deleting).resolves.toBe(true)
    expect(deleteStore.delete).toHaveBeenCalledWith('gone')

    const loading = loadTemplates(64, 1)
    loadOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    loadRequest.onsuccess?.(new Event('success'))
    loadTransaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([])
    expect(loadStore.openCursor).toHaveBeenCalledOnce()
    expect(cursor.continue).not.toHaveBeenCalled()
  })
})
