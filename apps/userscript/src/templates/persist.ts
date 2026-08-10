import { warn } from '../debug.js'
import { isUint8Array } from '../page-world.js'
import type { Appearance } from './appearance.js'
import {
  type ImportedTemplate,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from './import.js'

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
const REVISIONS = 'local-template-revisions'
// Shared with server-cache.ts: one database, one version, both stores created in either upgrade.
const VERSION = 3

export interface StoredTemplate extends ImportedTemplate {
  readonly visible: boolean
  readonly everPlaced: boolean
  readonly appearance?: Appearance
  /** Monotonic compare-and-swap token. Records written before v3 restore as revision zero. */
  readonly revision: number
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(REVISIONS)) {
        db.createObjectStore(REVISIONS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('server-cache')) {
        db.createObjectStore('server-cache', { keyPath: 'url' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'))
  })

const writeVersioned = async (
  id: string,
  expectedRevision: number | null,
  operation: (templates: IDBObjectStore, revisions: IDBObjectStore, nextRevision: number) => void,
): Promise<number | null> => {
  try {
    const db = await open()
    try {
      return await new Promise<number | null>((resolve, reject) => {
        const transaction = db.transaction([STORE, REVISIONS], 'readwrite')
        const templates = transaction.objectStore(STORE)
        const revisions = transaction.objectStore(REVISIONS)
        const request = revisions.get(id)
        let result: number | null = null
        request.onsuccess = () => {
          const stored = request.result as { revision?: unknown } | undefined
          const actual =
            stored !== undefined && Number.isSafeInteger(stored.revision)
              ? (stored.revision as number)
              : expectedRevision === 0
                ? 0
                : null
          if (actual !== expectedRevision) return
          const nextRevision = (actual ?? 0) + 1
          operation(templates, revisions, nextRevision)
          result = nextRevision
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
    warn('install', 'local template storage unavailable', String(error))
    return null
  }
}

export const saveTemplate = async (
  template: StoredTemplate,
  expectedRevision: number | null,
): Promise<number | null> => {
  const { indices, ...metadata } = template
  return await writeVersioned(template.id, expectedRevision, (templates, revisions, revision) => {
    // IndexedDB can inspect a Blob's size without first allocating an equally large typed array.
    // Legacy Uint8Array records remain readable; all new writes use this bounded representation.
    const bytes =
      indices.byteOffset === 0 && indices.byteLength === indices.buffer.byteLength
        ? (indices.buffer as ArrayBuffer)
        : indices.slice().buffer
    templates.put({ ...metadata, revision, indices: new Blob([bytes]) })
    revisions.put({ id: template.id, revision })
  })
}

export const deleteTemplate = async (id: string, expectedRevision: number): Promise<boolean> =>
  (await writeVersioned(id, expectedRevision, (templates, revisions, revision) => {
    templates.delete(id)
    // Keep only the small revision tombstone. A stale tab can no longer recreate the pixels.
    revisions.put({ id, revision })
  })) !== null

interface StoredBlob {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

const isStoredBlob = (value: unknown): value is StoredBlob =>
  typeof value === 'object' &&
  value !== null &&
  Number.isSafeInteger((value as StoredBlob).size) &&
  (value as StoredBlob).size >= 0 &&
  typeof (value as StoredBlob).arrayBuffer === 'function'

const boundedStoredCandidate = (
  value: unknown,
): value is Record<string, unknown> & {
  indices: Uint8Array | StoredBlob
} => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > MAX_TEMPLATE_ID_LENGTH ||
    typeof record.name !== 'string' ||
    record.name.length > MAX_TEMPLATE_NAME_LENGTH ||
    !['wplace', 'marble', 'image'].includes(String(record.source)) ||
    !Number.isSafeInteger(record.originX) ||
    !Number.isSafeInteger(record.originY) ||
    !Number.isSafeInteger(record.width) ||
    !Number.isSafeInteger(record.height) ||
    (!isUint8Array(record.indices) && !isStoredBlob(record.indices)) ||
    !Number.isSafeInteger(record.moved) ||
    !Number.isSafeInteger(record.opaque) ||
    typeof record.visible !== 'boolean' ||
    typeof record.everPlaced !== 'boolean'
  ) {
    return false
  }
  if (
    record.revision !== undefined &&
    (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0)
  ) {
    return false
  }
  const appearance = record.appearance
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    'hiddenColours' in appearance &&
    Array.isArray(appearance.hiddenColours) &&
    appearance.hiddenColours.length > 64
  ) {
    return false
  }
  return true
}

export const loadTemplates = async (
  maxTemplates = 64,
  maxIndexPixels = 64 * 1024 * 1024,
): Promise<readonly unknown[]> => {
  try {
    const db = await open()
    try {
      const candidates = await new Promise<
        readonly (Record<string, unknown> & { indices: Uint8Array | StoredBlob })[]
      >((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).openCursor()
        const templates: (Record<string, unknown> & {
          indices: Uint8Array | StoredBlob
        })[] = []
        let indexPixels = 0
        let inspected = 0
        const maxInspected = Math.max(maxTemplates, maxTemplates * 4)
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor === null) return
          inspected++
          const value: unknown = cursor.value
          if (inspected > maxInspected) return
          if (!boundedStoredCandidate(value)) {
            cursor.continue()
            return
          }
          const pixels = isUint8Array(value.indices) ? value.indices.length : value.indices.size
          // An individually oversized or late non-fitting record must not permanently hide every
          // later valid key. Inspect a bounded number of records, retaining only those that fit.
          if (pixels > maxIndexPixels || indexPixels + pixels > maxIndexPixels) {
            cursor.continue()
            return
          }
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
      const templates: unknown[] = []
      for (const candidate of candidates) {
        if (isUint8Array(candidate.indices)) {
          templates.push({ ...candidate, revision: candidate.revision ?? 0 })
          continue
        }
        try {
          const buffer = await candidate.indices.arrayBuffer()
          if (buffer.byteLength !== candidate.indices.size) continue
          templates.push({
            ...candidate,
            revision: candidate.revision ?? 0,
            indices: new Uint8Array(buffer),
          })
        } catch (error) {
          warn('install', `could not read local template ${String(candidate.id)}`, String(error))
        }
      }
      return templates
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return []
  }
}
