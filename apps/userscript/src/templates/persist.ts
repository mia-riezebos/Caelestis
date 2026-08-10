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
  operation: (templates: IDBObjectStore, nextRevision: number) => void,
  incrementRevision = true,
): Promise<SaveResult> => {
  try {
    const db = await open()
    try {
      return await new Promise<SaveResult>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        const templates = transaction.objectStore(STORE)
        const request = templates.get(id)
        let result: SaveResult = { status: 'conflict' }
        request.onsuccess = () => {
          const current = request.result as { revision?: unknown } | undefined
          if (expectedRevision === null) {
            if (current !== undefined) return
          } else {
            if (current === undefined) return
            const actual = Number.isSafeInteger(current.revision) ? (current.revision as number) : 0
            if (incrementRevision && actual >= Number.MAX_SAFE_INTEGER) return
            if (actual !== expectedRevision) return
          }
          const nextRevision = incrementRevision
            ? (expectedRevision ?? 0) + 1
            : (expectedRevision ?? 0)
          operation(templates, nextRevision)
          result = { status: 'saved', revision: nextRevision }
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
    return { status: 'unavailable' }
  }
}

export type SaveResult =
  | { readonly status: 'saved'; readonly revision: number }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' }

export const saveTemplate = async (
  template: StoredTemplate,
  expectedRevision: number | null,
): Promise<SaveResult> => {
  const { indices, ...metadata } = template
  return await writeVersioned(template.id, expectedRevision, (templates, revision) => {
    // IndexedDB can inspect a Blob's size without first allocating an equally large typed array.
    // Legacy Uint8Array records remain readable; all new writes use this bounded representation.
    const bytes =
      indices.byteOffset === 0 && indices.byteLength === indices.buffer.byteLength
        ? (indices.buffer as ArrayBuffer)
        : indices.slice().buffer
    templates.put({ ...metadata, revision, indices: new Blob([bytes]) })
  })
}

export const deleteTemplate = async (id: string, expectedRevision: number): Promise<SaveResult> =>
  await writeVersioned(
    id,
    expectedRevision,
    (templates) => {
      templates.delete(id)
      // Record absence is itself the tombstone: a stale mutation requires an existing record with the
      // expected revision, so deleted IDs need no permanent side-store entry.
    },
    false,
  )

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
    typeof record.source !== 'string' ||
    !['wplace', 'marble', 'image'].includes(record.source) ||
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

type HydrationResult =
  | { readonly status: 'loaded'; readonly template: unknown }
  | { readonly status: 'invalid' }
  | { readonly status: 'unavailable' }

const hydrateCandidate = async (
  candidate: Record<string, unknown> & { indices: Uint8Array | StoredBlob },
): Promise<HydrationResult> => {
  if (isUint8Array(candidate.indices)) {
    return {
      status: 'loaded',
      template: { ...candidate, revision: candidate.revision ?? 0 },
    }
  }
  try {
    const buffer = await candidate.indices.arrayBuffer()
    if (buffer.byteLength !== candidate.indices.size) return { status: 'invalid' }
    return {
      status: 'loaded',
      template: {
        ...candidate,
        revision: candidate.revision ?? 0,
        indices: new Uint8Array(buffer),
      },
    }
  } catch (error) {
    warn('install', `could not read local template ${String(candidate.id)}`, String(error))
    return { status: 'unavailable' }
  }
}

export type LoadTemplateResult =
  | { readonly status: 'loaded'; readonly template: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable' }

/** Read one winning CAS value after a conflict without materialising every other template. */
export const loadTemplate = async (
  id: string,
  maxIndexPixels = 64 * 1024 * 1024,
): Promise<LoadTemplateResult> => {
  try {
    const db = await open()
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).get(id)
        let result: unknown
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
      if (!boundedStoredCandidate(value)) return { status: 'missing' }
      const pixels = isUint8Array(value.indices) ? value.indices.length : value.indices.size
      if (pixels > maxIndexPixels) return { status: 'missing' }
      const hydrated = await hydrateCandidate(value)
      if (hydrated.status === 'invalid') return { status: 'missing' }
      return hydrated
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return { status: 'unavailable' }
  }
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
          if (templates.length >= maxTemplates) return
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
        const hydrated = await hydrateCandidate(candidate)
        if (hydrated.status === 'loaded') templates.push(hydrated.template)
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
