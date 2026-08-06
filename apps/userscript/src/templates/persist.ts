import { warn } from '../debug.js'
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
const VERSION = 1

export interface StoredTemplate extends ImportedTemplate {
  readonly visible: boolean
  readonly everPlaced: boolean
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' })
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
    return await new Promise<T>((resolve, reject) => {
      const request = body(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
    })
  } catch (error) {
    // Private browsing, a blocked origin, or a quota refusal all land here. Templates staying in
    // memory for the session is a real degradation, but it is not a reason to break the panel.
    warn('install', 'local template storage unavailable', String(error))
    return null
  }
}

export const saveTemplate = async (template: StoredTemplate): Promise<void> => {
  await run('readwrite', (store) => store.put(template))
}

export const deleteTemplate = async (id: string): Promise<void> => {
  await run('readwrite', (store) => store.delete(id))
}

export const loadTemplates = async (): Promise<readonly StoredTemplate[]> => {
  const all = await run<StoredTemplate[]>('readonly', (store) => store.getAll())
  return all ?? []
}
