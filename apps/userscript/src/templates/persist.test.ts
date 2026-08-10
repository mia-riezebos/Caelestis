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
})
