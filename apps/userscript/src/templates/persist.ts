import { WORLD_PIXELS } from '@caelestis/shared'
import { warn } from '../debug.js'
import { isStoredBlob, isUint8Array, type StoredBlob } from '../page-world.js'
import type { Appearance, AppearanceGroup } from './appearance.js'
import {
  type ImportedTemplate,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from './import.js'
import {
  hasCurrentPalette,
  markCurrentPalette,
  migrateTemplateStorePalette,
  remapPaletteIndices,
  remapStoredAppearance,
} from './palette-migration.js'

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
const VERSION = 4
const MAX_PERSISTED_TEMPLATES = 64
const MAX_PERSISTED_INDEX_PIXELS = 64 * 1024 * 1024
let blockedOpenRequest: IDBOpenDBRequest | null = null
let blockedOpenRecovery: Promise<void> | null = null
let settleBlockedOpen: (() => void) | null = null

const markOpenBlocked = (request: IDBOpenDBRequest): void => {
  blockedOpenRequest = request
  if (blockedOpenRecovery !== null) return
  blockedOpenRecovery = new Promise<void>((resolve) => {
    settleBlockedOpen = resolve
  })
}

const finishBlockedOpen = (request: IDBOpenDBRequest): void => {
  if (blockedOpenRequest !== request) return
  blockedOpenRequest = null
  const settle = settleBlockedOpen
  settleBlockedOpen = null
  blockedOpenRecovery = null
  settle?.()
}

export interface StoredTemplate extends ImportedTemplate {
  readonly visible: boolean
  readonly everPlaced: boolean
  /** Null means "follow the global appearance"; absent means the same, from before this was stored. */
  readonly appearance?: Appearance | null
  /** Monotonic compare-and-swap token. Records written before v3 restore as revision zero. */
  readonly revision: number
  /**
   * Which appearance groups this template answers for itself.
   *
   * Absent on anything stored before ownership was per group, where holding an appearance at all
   * meant owning everything — which is how it is read back.
   */
  readonly owns?: readonly AppearanceGroup[]
  /** Which Local folder this is in. Absent means the top level, as it did before folders existed. */
  readonly folderId?: string | null
}

const open = (): Promise<IDBDatabase> => {
  if (blockedOpenRequest !== null) {
    return Promise.reject(new Error('indexedDB.open is still blocked by another connection'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    let abandoned = false
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains('server-cache')) {
        db.createObjectStore('server-cache', { keyPath: 'url' })
      }
      if (event.oldVersion < 4) {
        const templates = request.transaction?.objectStore(STORE)
        if (templates !== undefined) migrateTemplateStorePalette(templates)
      }
    }
    request.onblocked = () => {
      abandoned = true
      markOpenBlocked(request)
      reject(new Error('indexedDB.open blocked by another connection'))
    }
    request.onsuccess = () => {
      const db = request.result
      finishBlockedOpen(request)
      if (abandoned) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => {
      finishBlockedOpen(request)
      reject(request.error ?? new Error('indexedDB.open failed'))
    }
  })
}

const normaliseRevision = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

const writeVersioned = async (
  id: IDBValidKey,
  expectedRevision: number | null,
  operation: (templates: IDBObjectStore, nextRevision: number, current: unknown) => void,
  incrementRevision = true,
  creationPixels: number | null = null,
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
            const actual = normaliseRevision(current.revision)
            if (incrementRevision && actual >= Number.MAX_SAFE_INTEGER - 1) return
            if (actual !== expectedRevision) return
          }
          const nextRevision = incrementRevision
            ? (expectedRevision ?? 0) + 1
            : (expectedRevision ?? 0)
          const commit = (): void => {
            operation(templates, nextRevision, current)
            result = { status: 'saved', revision: nextRevision }
          }
          if (expectedRevision !== null || creationPixels === null) {
            commit()
            return
          }
          // Read-write transactions on one object store are serialized across every connection.
          // Scanning and inserting inside this transaction makes the aggregate limits cross-tab
          // atomic without a second ledger that could drift from the records it accounts for.
          let records = 0
          let pixels = 0
          const cursorRequest = templates.openCursor()
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (cursor === null) {
              if (
                records < MAX_PERSISTED_TEMPLATES &&
                pixels + creationPixels <= MAX_PERSISTED_INDEX_PIXELS
              ) {
                commit()
              } else {
                result = { status: 'limit' }
              }
              return
            }
            records++
            pixels = boundedPixelSum(pixels, candidateIndexPixels(cursor.value))
            if (
              records >= MAX_PERSISTED_TEMPLATES ||
              pixels + creationPixels > MAX_PERSISTED_INDEX_PIXELS
            ) {
              result = { status: 'limit' }
              return
            }
            cursor.continue()
          }
          cursorRequest.onerror = () =>
            reject(cursorRequest.error ?? new Error('indexedDB cursor failed'))
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
  | { readonly status: 'limit' }
  | { readonly status: 'unavailable' }

export const saveTemplate = async (
  template: StoredTemplate,
  expectedRevision: number | null,
): Promise<SaveResult> => {
  const { indices, ...metadata } = template
  return await writeVersioned(
    template.id,
    expectedRevision,
    (templates, revision, current) => {
      // IndexedDB can inspect a Blob's size without first allocating an equally large typed array.
      // Legacy Uint8Array records remain readable; all new writes use this bounded representation.
      const currentIndices =
        expectedRevision !== null &&
        typeof current === 'object' &&
        current !== null &&
        'indices' in current
          ? current.indices
          : undefined
      const reusable =
        hasCurrentPalette(current) &&
        (isUint8Array(currentIndices) || isStoredBlob(currentIndices)) &&
        candidateIndexPixels(current) === indices.length
      if (reusable) {
        // Metadata-only mutations keep the already-cloned durable value. Re-wrapping a multi-MB
        // ArrayBuffer in a Blob copies it and makes every move/toggle/appearance change rewrite all
        // pixels even though this PR has no pixel-editing mutation.
        const record: Record<string, unknown> = { ...metadata, revision, indices: currentIndices }
        delete record.paletteMigration
        if (typeof current === 'object' && current !== null && 'paletteMigration' in current) {
          record.paletteMigration = current.paletteMigration
        }
        templates.put(record)
      } else {
        const bytes =
          indices.byteOffset === 0 && indices.byteLength === indices.buffer.byteLength
            ? (indices.buffer as ArrayBuffer)
            : indices.slice().buffer
        templates.put(markCurrentPalette({ ...metadata, revision, indices: new Blob([bytes]) }))
      }
    },
    true,
    expectedRevision === null ? indices.length : null,
  )
}

export interface TemplateFolderUpdate {
  readonly id: string
  readonly expectedRevision: number
  readonly folderId: string | null
}

export type SaveTemplateFoldersResult =
  | { readonly status: 'saved'; readonly revisions: ReadonlyMap<string, number> }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' }

/** Save several folder assignments in one IndexedDB transaction, or none of them. */
export const saveTemplateFolders = async (
  updates: readonly TemplateFolderUpdate[],
): Promise<SaveTemplateFoldersResult> => {
  if (updates.length === 0) return { status: 'saved', revisions: new Map() }
  if (new Set(updates.map(({ id }) => id)).size !== updates.length) return { status: 'conflict' }
  try {
    const db = await open()
    try {
      return await new Promise<SaveTemplateFoldersResult>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        const templates = transaction.objectStore(STORE)
        const current = new Map<string, Record<string, unknown>>()
        let remaining = updates.length
        let conflict = false
        let result: SaveTemplateFoldersResult = { status: 'conflict' }

        const finishReads = (): void => {
          if (remaining !== 0) return
          if (conflict) return
          const revisions = new Map<string, number>()
          for (const update of updates) {
            const record = current.get(update.id)
            if (record === undefined) return
            const revision = update.expectedRevision + 1
            templates.put({ ...record, folderId: update.folderId, revision })
            revisions.set(update.id, revision)
          }
          result = { status: 'saved', revisions }
        }

        for (const update of updates) {
          const request = templates.get(update.id)
          request.onsuccess = () => {
            const record = request.result
            if (
              typeof record !== 'object' ||
              record === null ||
              normaliseRevision((record as { revision?: unknown }).revision) !==
                update.expectedRevision ||
              update.expectedRevision >= Number.MAX_SAFE_INTEGER - 1
            ) {
              conflict = true
            } else {
              current.set(update.id, record as Record<string, unknown>)
            }
            remaining--
            finishReads()
          }
          request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        }
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

export const deleteTemplate = async (
  id: IDBValidKey,
  expectedRevision: number,
): Promise<SaveResult> =>
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

const boundedStoredCandidate = (
  value: unknown,
): value is Record<string, unknown> & {
  indices: Uint8Array | StoredBlob
} => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const indices = record.indices
  const indexPixels = isUint8Array(indices)
    ? indices.length
    : isStoredBlob(indices)
      ? indices.size
      : -1
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > MAX_TEMPLATE_ID_LENGTH ||
    typeof record.name !== 'string' ||
    record.name.length > MAX_TEMPLATE_NAME_LENGTH ||
    typeof record.source !== 'string' ||
    !['wplace', 'marble', 'image'].includes(record.source) ||
    !Number.isSafeInteger(record.originX) ||
    Number(record.originX) < 0 ||
    !Number.isSafeInteger(record.originY) ||
    Number(record.originY) < 0 ||
    !Number.isSafeInteger(record.width) ||
    Number(record.width) <= 0 ||
    !Number.isSafeInteger(record.height) ||
    Number(record.height) <= 0 ||
    indexPixels < 0 ||
    !Number.isSafeInteger(record.moved) ||
    Number(record.moved) < 0 ||
    !Number.isSafeInteger(record.opaque) ||
    Number(record.opaque) <= 0 ||
    Number(record.moved) > Number(record.opaque) ||
    Number(record.opaque) > indexPixels ||
    typeof record.visible !== 'boolean' ||
    typeof record.everPlaced !== 'boolean' ||
    (record.sortOrder !== undefined && !Number.isSafeInteger(record.sortOrder))
  ) {
    return false
  }
  const width = Number(record.width)
  const height = Number(record.height)
  const originX = Number(record.originX)
  const originY = Number(record.originY)
  if (
    width > WORLD_PIXELS ||
    height > WORLD_PIXELS ||
    originX > WORLD_PIXELS - width ||
    originY > WORLD_PIXELS - height ||
    indexPixels !== width * height ||
    (record.source === 'image' && record.everPlaced === false)
  ) {
    return false
  }
  if (
    record.revision !== undefined &&
    (!Number.isSafeInteger(record.revision) ||
      Number(record.revision) < 0 ||
      Number(record.revision) >= Number.MAX_SAFE_INTEGER)
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
  | {
      readonly status: 'loaded'
      readonly template: unknown
      readonly migrated?: Record<string, unknown>
    }
  | { readonly status: 'invalid' }
  | { readonly status: 'unavailable' }

interface TemplateLoadFailureBase {
  readonly kind: 'template-hydration-failure'
  readonly status: 'invalid' | 'unavailable' | 'skipped'
  readonly revision: number
  /** Bytes materialised/attempted for this candidate, charged to the whole restore operation. */
  readonly indexPixels: number
}

export type TemplateLoadFailure = TemplateLoadFailureBase &
  ({ readonly id: string } | { readonly status: 'invalid'; readonly key: IDBValidKey })

export type TemplateLoadBatch = readonly unknown[] & {
  /** Non-excluded cursor rows inspected, including malformed and oversized records. */
  readonly inspected: number
  /** Pixel bytes represented by every inspected row whose size was cheaply knowable. */
  readonly indexPixels: number
  /** Resolves once a blocked native open has settled and one bounded restore retry may be attempted. */
  readonly retryAfterUnavailable: Promise<void> | null
}

const candidateIndexPixels = (value: unknown): number => {
  if (typeof value !== 'object' || value === null || !('indices' in value)) return 0
  const indices = (value as { readonly indices?: unknown }).indices
  if (isUint8Array(indices)) return indices.length
  if (isStoredBlob(indices)) return indices.size
  return 0
}

const boundedPixelSum = (total: number, pixels: number): number =>
  pixels > Number.MAX_SAFE_INTEGER - total ? Number.MAX_SAFE_INTEGER : total + pixels

const loadBatch = (
  templates: unknown[],
  inspected: number,
  indexPixels: number,
  retryAfterUnavailable: Promise<void> | null = null,
): TemplateLoadBatch => {
  // Keep the metrics out of array iteration and equality: callers that only need the candidates
  // remain ordinary array consumers, while restore can account for cursor work that produced no
  // candidate at all.
  Object.defineProperties(templates, {
    inspected: { value: inspected, enumerable: false },
    indexPixels: { value: indexPixels, enumerable: false },
    retryAfterUnavailable: { value: retryAfterUnavailable, enumerable: false },
  })
  return templates as unknown as TemplateLoadBatch
}

const hydrateCandidate = async (
  candidate: Record<string, unknown> & { indices: Uint8Array | StoredBlob },
): Promise<HydrationResult> => {
  const finish = (indices: Uint8Array): HydrationResult => {
    if (hasCurrentPalette(candidate)) {
      return {
        status: 'loaded',
        template: { ...candidate, revision: candidate.revision ?? 0, indices },
      }
    }
    const remapped = remapPaletteIndices(indices)
    const migrated = markCurrentPalette({
      ...candidate,
      indices: new Blob([remapped.buffer as ArrayBuffer]),
      appearance: remapStoredAppearance(candidate.appearance),
    })
    return {
      status: 'loaded',
      template: { ...migrated, revision: candidate.revision ?? 0, indices: remapped },
      migrated,
    }
  }
  if (isUint8Array(candidate.indices)) {
    return finish(candidate.indices)
  }
  try {
    const buffer = await candidate.indices.arrayBuffer()
    if (buffer.byteLength !== candidate.indices.size) return { status: 'invalid' }
    return finish(new Uint8Array(buffer))
  } catch (error) {
    warn('install', `could not read local template ${String(candidate.id)}`, String(error))
    return { status: 'unavailable' }
  }
}

const persistLoadedPaletteMigration = async (
  candidate: Record<string, unknown>,
  migrated: Record<string, unknown>,
): Promise<void> => {
  const id = candidate.id
  if (typeof id !== 'string') return
  await writeVersioned(
    id,
    storedRevision(candidate),
    (templates, _revision, current) => {
      if (typeof current !== 'object' || current === null || hasCurrentPalette(current)) return
      templates.put(migrated)
    },
    false,
  )
}

export type LoadTemplateResult =
  | { readonly status: 'loaded'; readonly template: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly revision: number }
  | { readonly status: 'unavailable' }

const storedRevision = (value: unknown): number => {
  if (typeof value !== 'object' || value === null || !('revision' in value)) return 0
  return normaliseRevision((value as { readonly revision?: unknown }).revision)
}

const loadFailureIdentity = (
  value: unknown,
  primaryKey: IDBValidKey | undefined,
):
  | { readonly id: string; readonly revision: number }
  | {
      readonly key: IDBValidKey
      readonly revision: number
    }
  | null => {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { readonly id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_TEMPLATE_ID_LENGTH) {
      return { id, revision: storedRevision(value) }
    }
  }
  return primaryKey === undefined ? null : { key: primaryKey, revision: storedRevision(value) }
}

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
      if (value === undefined) return { status: 'missing' }
      if (!boundedStoredCandidate(value)) {
        return { status: 'invalid', revision: storedRevision(value) }
      }
      const pixels = isUint8Array(value.indices) ? value.indices.length : value.indices.size
      if (pixels > maxIndexPixels) return { status: 'invalid', revision: storedRevision(value) }
      const hydrated = await hydrateCandidate(value)
      if (hydrated.status === 'invalid') {
        return { status: 'invalid', revision: storedRevision(value) }
      }
      if (hydrated.status === 'loaded' && hydrated.migrated !== undefined) {
        void persistLoadedPaletteMigration(value, hydrated.migrated)
      }
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
  excludedRevisions: ReadonlyMap<string, number> = new Map(),
): Promise<TemplateLoadBatch> => {
  try {
    const db = await open()
    try {
      const batch = await new Promise<{
        readonly candidates: readonly (
          | (Record<string, unknown> & { indices: Uint8Array | StoredBlob })
          | TemplateLoadFailure
        )[]
        readonly inspected: number
        readonly indexPixels: number
      }>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).openCursor()
        const templates: (
          | (Record<string, unknown> & { indices: Uint8Array | StoredBlob })
          | TemplateLoadFailure
        )[] = []
        let retainedPixels = 0
        let inspectedPixels = 0
        let inspected = 0
        let retainedTemplates = 0
        const maxInspected = Math.max(maxTemplates, maxTemplates * 4)
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor === null) return
          const value: unknown = cursor.value
          if (!boundedStoredCandidate(value)) {
            const identity = loadFailureIdentity(value, cursor.primaryKey)
            if (
              identity !== null &&
              'id' in identity &&
              excludedRevisions.get(identity.id) === identity.revision
            ) {
              cursor.continue()
              return
            }
            inspected++
            const pixels = candidateIndexPixels(value)
            inspectedPixels = boundedPixelSum(inspectedPixels, pixels)
            if (identity !== null) {
              templates.push({
                kind: 'template-hydration-failure',
                status: 'invalid',
                ...identity,
                indexPixels: pixels,
              })
            }
            if (inspected >= maxInspected) return
            cursor.continue()
            return
          }
          const revision = storedRevision(value)
          if (excludedRevisions.get(value.id as string) === revision) {
            cursor.continue()
            return
          }
          inspected++
          const pixels = isUint8Array(value.indices) ? value.indices.length : value.indices.size
          inspectedPixels = boundedPixelSum(inspectedPixels, pixels)
          // An individually oversized or late non-fitting record must not permanently hide every
          // later valid key. Inspect a bounded number of records, retaining only those that fit.
          if (pixels > 64 * 1024 * 1024) {
            templates.push({
              kind: 'template-hydration-failure',
              status: 'invalid',
              id: value.id as string,
              revision,
              indexPixels: pixels,
            })
            if (inspected >= maxInspected) return
            cursor.continue()
            return
          }
          if (pixels > maxIndexPixels || retainedPixels + pixels > maxIndexPixels) {
            templates.push({
              kind: 'template-hydration-failure',
              status: 'skipped',
              id: value.id as string,
              revision,
              indexPixels: pixels,
            })
            if (inspected >= maxInspected) return
            cursor.continue()
            return
          }
          templates.push(value)
          retainedTemplates++
          retainedPixels += pixels
          if (retainedTemplates >= maxTemplates) return
          if (inspected >= maxInspected) return
          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB cursor failed'))
        transaction.oncomplete = () =>
          resolve({ candidates: templates, inspected, indexPixels: inspectedPixels })
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
      const templates: unknown[] = []
      for (const candidate of batch.candidates) {
        if (!('indices' in candidate)) {
          templates.push(candidate)
          continue
        }
        const hydrated = await hydrateCandidate(candidate)
        if (hydrated.status === 'loaded') {
          if (hydrated.migrated !== undefined) {
            void persistLoadedPaletteMigration(candidate, hydrated.migrated)
          }
          templates.push(hydrated.template)
        } else {
          templates.push({
            kind: 'template-hydration-failure',
            status: hydrated.status,
            id: candidate.id as string,
            revision: storedRevision(candidate),
            indexPixels: isUint8Array(candidate.indices)
              ? candidate.indices.length
              : candidate.indices.size,
          } satisfies TemplateLoadFailure)
        }
      }
      return loadBatch(templates, batch.inspected, batch.indexPixels)
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return loadBatch([], 0, 0, blockedOpenRecovery)
  }
}
