import { warn } from '../debug.js'
import type { Appearance } from './appearance.js'
import type { ImportedTemplate } from './import.js'

/**
 * Local templates on disk.
 *
 * IndexedDB rather than `GM_setValue` or `localStorage`, for a reason that is not preference: the
 * observed `.wplace` file is 11 MB and its decoded index array is 4 MB, which is past what a string
 * store will hold and would have to be base64'd to get there. IndexedDB takes a `Uint8Array`
 * directly.
 *
 * This is what makes navigating to an imported template survivable. There is no reachable MapLibre
 * instance, so going to a coordinate means a page load — and without persistence the import would
 * be destroyed by the very navigation meant to show it off.
 */

const DB_NAME = 'caelestis'
const STORE = 'local-templates'
// Shared with server-cache.ts: one database, one version, both stores created in either upgrade.
const VERSION = 2

export interface StoredTemplate extends ImportedTemplate {
  readonly visible: boolean
  readonly everPlaced: boolean
  readonly appearance?: Appearance
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains('server-cache')) {
        db.createObjectStore('server-cache', { keyPath: 'url' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'))
  })

const run = async <T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> => {
  try {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = body(transaction.objectStore(STORE))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    // Private browsing, a blocked origin, or a quota refusal all land here. Templates staying in
    // memory for the session is a real degradation, but it is not a reason to break the panel.
    warn('install', 'local template storage unavailable', String(error))
    return null
  }
}

export const saveTemplate = async (template: StoredTemplate): Promise<boolean> => {
  return (await run('readwrite', (store) => store.put(template))) !== null
}

export const deleteTemplate = async (id: string): Promise<boolean> => {
  return (await run('readwrite', (store) => store.delete(id))) !== null
}

export const loadTemplates = async (
  maxTemplates = 64,
  maxIndexPixels = 64 * 1024 * 1024,
): Promise<readonly unknown[]> => {
  try {
    const db = await open()
    try {
      return await new Promise<readonly unknown[]>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).openCursor()
        const templates: unknown[] = []
        let indexPixels = 0
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor === null) return
          const value: unknown = cursor.value
          const pixels =
            typeof value === 'object' &&
            value !== null &&
            'indices' in value &&
            value.indices instanceof Uint8Array
              ? value.indices.length
              : 0
          // Do not continue the cursor once either aggregate cap is reached. The transaction then
          // completes naturally, while only the bounded prefix has ever been retained in memory.
          if (templates.length >= maxTemplates || indexPixels + pixels > maxIndexPixels) return
          templates.push(value)
          indexPixels += pixels
          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB cursor failed'))
        transaction.oncomplete = () => resolve(templates)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return []
  }
}
