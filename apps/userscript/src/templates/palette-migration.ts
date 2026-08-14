import { isStoredBlob, isUint8Array } from '../page-world.js'

/** Old persisted palette indices mapped to wplace's authoritative current ordering. */
const OLD_TO_CURRENT = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 17, 18, 20, 21, 22, 23, 24, 25, 26,
  27, 28, 29, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 52, 53, 54,
  49, 55, 56, 35, 50, 51, 60, 61, 62, 57, 58, 59, 63,
] as const

const remapIndex = (value: number): number => OLD_TO_CURRENT[value] ?? value

export const remapPaletteColours = (values: readonly number[]): number[] => [
  ...new Set(values.map(remapIndex)),
]

export const remapPaletteIndices = (values: Uint8Array): Uint8Array => {
  const remapped = new Uint8Array(values.length)
  for (let index = 0; index < values.length; index++) {
    remapped[index] = remapIndex(values[index] as number)
  }
  return remapped
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MAX_MIGRATED_INDEX_BYTES = 64 * 1024 * 1024

export const remapStoredAppearance = (value: unknown): unknown => {
  if (!isRecord(value) || !Array.isArray(value.hiddenColours)) return value
  const hidden = value.hiddenColours.filter((entry): entry is number => Number.isSafeInteger(entry))
  return { ...value, hiddenColours: remapPaletteColours(hidden) }
}

/** Rewrite local-template records inside the caller's IndexedDB version-change transaction. */
export const migrateTemplateStorePalette = (store: IDBObjectStore): void => {
  const request = store.openCursor()
  request.onsuccess = () => {
    const cursor = request.result
    if (cursor === null) return
    const value: unknown = cursor.value
    if (!isRecord(value)) {
      cursor.continue()
      return
    }
    const appearance = remapStoredAppearance(value.appearance)
    if (isUint8Array(value.indices)) {
      if (value.indices.length > MAX_MIGRATED_INDEX_BYTES) {
        cursor.continue()
        return
      }
      cursor.update({ ...value, indices: remapPaletteIndices(value.indices), appearance })
      cursor.continue()
      return
    }
    const storedIndices = value.indices
    if (!isStoredBlob(storedIndices) || storedIndices.size > MAX_MIGRATED_INDEX_BYTES) {
      cursor.continue()
      return
    }

    // Blob reads are asynchronous, while a version-change transaction stays active only while it
    // has IndexedDB requests outstanding. Keep one harmless read in flight and apply the remap from
    // that request's success callback, where the transaction is active again. If the Blob cannot be
    // read, skip this invalid record just as the ordinary template loader does. One unreadable row
    // must not prevent the version upgrade from preserving every other local template.
    let migrated: Blob | null = null
    let failed = false
    void storedIndices
      .arrayBuffer()
      .then((buffer) => {
        if (buffer.byteLength !== storedIndices.size) {
          failed = true
          return
        }
        const remapped = remapPaletteIndices(new Uint8Array(buffer))
        migrated = new Blob([remapped.buffer as ArrayBuffer])
      })
      .catch(() => {
        failed = true
      })

    const keepAlive = (): void => {
      const pending = store.get(cursor.primaryKey)
      pending.onsuccess = () => {
        if (failed) {
          cursor.continue()
          return
        }
        if (migrated === null) {
          keepAlive()
          return
        }
        cursor.update({ ...value, indices: migrated, appearance })
        cursor.continue()
      }
    }
    keepAlive()
  }
}
