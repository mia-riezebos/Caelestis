import { afterEach, describe, expect, it, vi } from 'vitest'

const stored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'loaded',
  name: 'Loaded',
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
  revision: 0,
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('local template persistence', () => {
  it('fails a blocked version upgrade instead of hanging and closes any late connection', async () => {
    const database = { close: vi.fn() } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates()
    opening.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)

    const loaded = await loading
    expect(loaded).toEqual([])
    opening.onsuccess?.(new Event('success'))
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('resolves a write only after its IndexedDB transaction commits', async () => {
    const templateRequest = { result: undefined } as unknown as IDBRequest<unknown>
    const templateStore = { get: vi.fn(() => templateRequest), put: vi.fn() }
    const transaction = {
      objectStore: vi.fn(() => templateStore),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { saveTemplate } = await import('./persist.js')
    let settled = false

    const saving = saveTemplate(
      {
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
        revision: 0,
      },
      null,
    ).then(() => {
      settled = true
    })
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    templateRequest.onsuccess?.(new Event('success'))
    await Promise.resolve()

    expect(settled).toBe(false)
    transaction.oncomplete?.(new Event('complete'))
    await saving
    expect(settled).toBe(true)
    expect(templateStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, indices: expect.any(Blob) }),
    )
  })

  it('reports a transaction abort as a failed durable write and closes the database', async () => {
    const templateRequest = { result: undefined } as unknown as IDBRequest<unknown>
    const templateStore = { get: vi.fn(() => templateRequest), put: vi.fn() }
    const transaction = {
      objectStore: vi.fn(() => templateStore),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { saveTemplate } = await import('./persist.js')

    const saving = saveTemplate(
      {
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
        revision: 0,
      },
      null,
    )
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    templateRequest.onsuccess?.(new Event('success'))
    transaction.onabort?.(new Event('abort'))

    await expect(saving).resolves.toEqual({ status: 'unavailable' })
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('refuses a stale cross-tab write without recreating the template', async () => {
    const templateRequest = {
      result: { id: 'test', revision: 2 },
    } as unknown as IDBRequest<unknown>
    const templateStore = { get: vi.fn(() => templateRequest), put: vi.fn() }
    const transaction = {
      objectStore: vi.fn(() => templateStore),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { saveTemplate } = await import('./persist.js')

    const saving = saveTemplate(stored({ id: 'test', revision: 1 }) as never, 1)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    templateRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(saving).resolves.toEqual({ status: 'conflict' })
    expect(templateStore.put).not.toHaveBeenCalled()
  })

  it('waits for durable deletes and skips records outside the aggregate pixel cap', async () => {
    const templateRequest = {
      result: stored({ id: 'gone', revision: 0 }),
    } as unknown as IDBRequest<unknown>
    const cursor = {
      value: stored({ width: 2, indices: new Uint8Array([0, 1]), opaque: 2 }),
      continue: vi.fn(),
    }
    const loadRequest = { result: cursor } as unknown as IDBRequest<IDBCursorWithValue | null>
    const deleteStore = { get: vi.fn(() => templateRequest), delete: vi.fn() }
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

    const deleting = deleteTemplate('gone', 0)
    deleteOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    templateRequest.onsuccess?.(new Event('success'))
    deleteTransaction.oncomplete?.(new Event('complete'))
    await expect(deleting).resolves.toEqual({ status: 'saved', revision: 0 })
    expect(deleteStore.delete).toHaveBeenCalledWith('gone')

    const loading = loadTemplates(64, 1)
    loadOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    loadRequest.onsuccess?.(new Event('success'))
    loadTransaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([])
    expect(loadStore.openCursor).toHaveBeenCalledOnce()
    expect(cursor.continue).toHaveBeenCalledOnce()
  })

  it('continues past one oversized record to recover a later valid record', async () => {
    const oversized = {
      value: stored({ id: 'oversized', width: 3, indices: new Uint8Array(3), opaque: 3 }),
      continue: vi.fn(),
    }
    const valid = {
      value: stored({ id: 'valid' }),
      continue: vi.fn(),
    }
    const mutableRequest = {
      result: oversized as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(64, 1)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = valid as unknown as IDBCursorWithValue
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = null
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([valid.value])
    expect(oversized.continue).toHaveBeenCalledOnce()
    expect(valid.continue).toHaveBeenCalledOnce()
  })

  it('does not charge excluded restore records against a later load pass', async () => {
    const excluded = {
      value: stored({ id: 'excluded' }),
      continue: vi.fn(),
    }
    const valid = {
      value: stored({ id: 'valid' }),
      continue: vi.fn(),
    }
    const mutableRequest = {
      result: excluded as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(64, 1, new Set(['excluded']))
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = valid as unknown as IDBCursorWithValue
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = null
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([valid.value])
    expect(excluded.continue).toHaveBeenCalledOnce()
    expect(valid.continue).toHaveBeenCalledOnce()
  })

  it('does not let excluded ids consume the bounded inspection window', async () => {
    const cursor = {
      value: stored({ id: 'excluded-0' }),
      continue: vi.fn(),
    }
    const mutableRequest = {
      result: cursor as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')
    const excludedIds = new Set(Array.from({ length: 52 }, (_, index) => `excluded-${index}`))

    const loading = loadTemplates(13, 1, excludedIds)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    for (const id of excludedIds) {
      cursor.value = stored({ id })
      mutableRequest.onsuccess?.(new Event('success'))
    }
    const valid = stored({ id: 'valid' })
    cursor.value = valid
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = null
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([valid])
  })

  it('reports batch hydration failures so restore can release their charged budget', async () => {
    const failedPixels = {
      size: 1,
      arrayBuffer: vi.fn(async () => await Promise.reject(new Error('I/O unavailable'))),
    }
    const failed = {
      value: stored({ id: 'failed', indices: failedPixels }),
      continue: vi.fn(),
    }
    const valid = {
      value: stored({ id: 'valid' }),
      continue: vi.fn(),
    }
    const mutableRequest = {
      result: failed as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(64, 2)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = valid as unknown as IDBCursorWithValue
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = null
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([
      {
        kind: 'template-hydration-failure',
        status: 'unavailable',
        id: 'failed',
        revision: 0,
        indexPixels: 1,
      },
      valid.value,
    ])
  })

  it('rejects an oversized Blob from metadata without materialising its bytes', async () => {
    const pixels = { size: 65, arrayBuffer: vi.fn(async () => new ArrayBuffer(65)) }
    const cursor = {
      value: stored({ width: 65, indices: pixels, opaque: 65 }),
      continue: vi.fn(),
    }
    const request = { result: cursor } as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(64, 64)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    ;(request as unknown as { result: IDBCursorWithValue | null }).result = null
    request.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    const loaded = await loading
    expect(loaded).toEqual([])
    expect(loaded.inspected).toBe(1)
    expect(loaded.indexPixels).toBe(65)
    expect(pixels.arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects boxed source strings before admitting a persisted record', async () => {
    const cursor = {
      value: stored({ source: new String('image') }),
      continue: vi.fn(),
    }
    const mutableRequest = {
      result: cursor as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates()
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    mutableRequest.onsuccess?.(new Event('success'))
    mutableRequest.result = null
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    const loaded = await loading
    expect(loaded).toEqual([
      {
        kind: 'template-hydration-failure',
        status: 'invalid',
        id: 'loaded',
        revision: 0,
        indexPixels: 1,
      },
    ])
    expect(loaded.inspected).toBe(1)
    expect(loaded.indexPixels).toBe(1)
    expect(cursor.continue).toHaveBeenCalledOnce()
  })

  it('stops at the retained template limit without hydrating the next Blob', async () => {
    const firstPixels = { size: 1, arrayBuffer: vi.fn(async () => new Uint8Array([0]).buffer) }
    const secondPixels = { size: 1, arrayBuffer: vi.fn(async () => new Uint8Array([0]).buffer) }
    const first = { value: stored({ id: 'first', indices: firstPixels }), continue: vi.fn() }
    const mutableRequest = {
      result: first as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    first.continue.mockImplementation(() => {
      mutableRequest.result = {
        value: stored({ id: 'second', indices: secondPixels }),
        continue: vi.fn(),
      } as unknown as IDBCursorWithValue
      mutableRequest.onsuccess?.(new Event('success'))
    })
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(1, 2)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    mutableRequest.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([expect.objectContaining({ id: 'first' })])
    expect(first.continue).not.toHaveBeenCalled()
    expect(firstPixels.arrayBuffer).toHaveBeenCalledOnce()
    expect(secondPixels.arrayBuffer).not.toHaveBeenCalled()
  })

  it('reports a transient single-record Blob hydration failure as unavailable', async () => {
    const pixels = {
      size: 1,
      arrayBuffer: vi.fn(async () => await Promise.reject(new Error('I/O unavailable'))),
    }
    const request = {
      result: stored({ indices: pixels }),
    } as unknown as IDBRequest<unknown>
    const transaction = {
      objectStore: vi.fn(() => ({ get: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplate } = await import('./persist.js')

    const loading = loadTemplate('loaded')
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual({ status: 'unavailable' })
    expect(pixels.arrayBuffer).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('reports a present structurally invalid single record as invalid', async () => {
    const request = { result: stored({ source: 'unknown', revision: 4 }) } as IDBRequest<unknown>
    const transaction = {
      objectStore: vi.fn(() => ({ get: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplate } = await import('./persist.js')

    const loading = loadTemplate('loaded')
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual({ status: 'invalid', revision: 4 })
  })

  it('distinguishes an absent single record from an invalid one', async () => {
    const request = { result: undefined } as IDBRequest<unknown>
    const transaction = {
      objectStore: vi.fn(() => ({ get: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplate } = await import('./persist.js')

    const loading = loadTemplate('absent')
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual({ status: 'missing' })
  })

  it('refuses to increment an exhausted revision but can still delete it', async () => {
    const maxRecord = stored({ id: 'max', revision: Number.MAX_SAFE_INTEGER })
    const saveRequest = { result: maxRecord } as unknown as IDBRequest<unknown>
    const deleteRequest = { result: maxRecord } as unknown as IDBRequest<unknown>
    const saveStore = { get: vi.fn(() => saveRequest), put: vi.fn() }
    const deleteStore = { get: vi.fn(() => deleteRequest), delete: vi.fn() }
    const saveTransaction = { objectStore: vi.fn(() => saveStore) } as unknown as IDBTransaction
    const deleteTransaction = {
      objectStore: vi.fn(() => deleteStore),
    } as unknown as IDBTransaction
    const databases = [
      { transaction: vi.fn(() => saveTransaction), close: vi.fn() },
      { transaction: vi.fn(() => deleteTransaction), close: vi.fn() },
    ] as unknown as IDBDatabase[]
    const saveOpening = { result: databases[0] } as IDBOpenDBRequest
    const deleteOpening = { result: databases[1] } as IDBOpenDBRequest
    const openings = [saveOpening, deleteOpening]
    vi.stubGlobal('indexedDB', { open: vi.fn(() => openings.shift()) })
    const { deleteTemplate, saveTemplate } = await import('./persist.js')

    const saving = saveTemplate(maxRecord as never, Number.MAX_SAFE_INTEGER)
    saveOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    saveRequest.onsuccess?.(new Event('success'))
    saveTransaction.oncomplete?.(new Event('complete'))
    await expect(saving).resolves.toEqual({ status: 'conflict' })
    expect(saveStore.put).not.toHaveBeenCalled()

    const deleting = deleteTemplate('max', Number.MAX_SAFE_INTEGER)
    deleteOpening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    deleteRequest.onsuccess?.(new Event('success'))
    deleteTransaction.oncomplete?.(new Event('complete'))
    await expect(deleting).resolves.toEqual({
      status: 'saved',
      revision: Number.MAX_SAFE_INTEGER,
    })
    expect(deleteStore.delete).toHaveBeenCalledWith('max')
  })

  it('surfaces invalid leading records so restore can collect them', async () => {
    const cursor = { value: {}, continue: vi.fn() }
    const mutableRequest = {
      result: cursor as unknown as IDBCursorWithValue,
    } as { result: IDBCursorWithValue | null; onsuccess?: (event: Event) => void }
    const request = mutableRequest as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates(64, 64)
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    for (let index = 0; index < 64; index++) {
      cursor.value = { id: `invalid-${index}` }
      mutableRequest.onsuccess?.(new Event('success'))
    }
    transaction.oncomplete?.(new Event('complete'))

    const loaded = await loading
    expect(loaded).toEqual(
      Array.from({ length: 64 }, (_, index) => ({
        kind: 'template-hydration-failure',
        status: 'invalid',
        id: `invalid-${index}`,
        revision: 0,
        indexPixels: 0,
      })),
    )
    expect(loaded.inspected).toBe(64)
  })

  it('loads indices cloned into a different Uint8Array realm', async () => {
    const foreignIndices = new Uint8Array([0])
    class SandboxUint8Array extends Uint8Array {}
    vi.stubGlobal('Uint8Array', SandboxUint8Array)
    const cursor = {
      value: stored({ indices: foreignIndices }),
      continue: vi.fn(),
    }
    const request = { result: cursor } as unknown as IDBRequest<IDBCursorWithValue | null>
    const transaction = {
      objectStore: vi.fn(() => ({ openCursor: vi.fn(() => request) })),
    } as unknown as IDBTransaction
    const database = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase
    const opening = { result: database } as IDBOpenDBRequest
    vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
    const { loadTemplates } = await import('./persist.js')

    const loading = loadTemplates()
    opening.onsuccess?.(new Event('success'))
    await Promise.resolve()
    request.onsuccess?.(new Event('success'))
    ;(request as unknown as { result: IDBCursorWithValue | null }).result = null
    request.onsuccess?.(new Event('success'))
    transaction.oncomplete?.(new Event('complete'))

    await expect(loading).resolves.toEqual([cursor.value])
  })
})
