import { describe, expect, it, vi } from 'vitest'
import {
  migrateTemplateStorePalette,
  remapPaletteColours,
  remapPaletteIndices,
  remapStoredAppearance,
} from './palette-migration.js'

const runMigration = async (value: unknown) => {
  const abort = vi.fn()
  const update = vi.fn()
  const continueCursor = vi.fn()
  const cursor = {
    value,
    primaryKey: 'template',
    update,
    continue: continueCursor,
  }
  const cursorRequest = {
    result: cursor as unknown as IDBCursorWithValue | null,
  } as IDBRequest<IDBCursorWithValue | null>
  const store = {
    transaction: { abort },
    openCursor: vi.fn(() => cursorRequest),
    get: vi.fn(() => {
      const request = {} as IDBRequest<unknown>
      queueMicrotask(() => request.onsuccess?.(new Event('success')))
      return request
    }),
  } as unknown as IDBObjectStore

  migrateTemplateStorePalette(store)
  cursorRequest.onsuccess?.(new Event('success'))
  for (
    let turn = 0;
    turn < 10 && update.mock.calls.length === 0 && abort.mock.calls.length === 0;
    turn++
  ) {
    await Promise.resolve()
  }
  return { abort, continueCursor, update }
}

describe('palette persistence migration', () => {
  it('applies the recovered old-to-current permutation', () => {
    expect([...remapPaletteIndices(Uint8Array.from([17, 18, 19, 35, 48, 54, 57, 60]))]).toEqual([
      19, 17, 18, 36, 52, 35, 60, 57,
    ])
  })

  it('keeps the 64 persisted palette entries a bijection', () => {
    const migrated = [...remapPaletteIndices(Uint8Array.from({ length: 64 }, (_, index) => index))]
    expect(new Set(migrated).size).toBe(64)
    expect([...migrated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    )
  })

  it('leaves non-palette sentinels unchanged', () => {
    expect([...remapPaletteIndices(Uint8Array.from([64, 127, 255]))]).toEqual([64, 127, 255])
  })

  it('remaps and deduplicates hidden colour lists', () => {
    expect(remapPaletteColours([17, 19, 17, 54])).toEqual([19, 18, 35])
  })

  it('rewrites only the hidden colours in a stored appearance', () => {
    const stored = { size: 0.5, hiddenColours: [35, 54] }
    expect(remapStoredAppearance(stored)).toEqual({ size: 0.5, hiddenColours: [36, 35] })
    expect(stored.hiddenColours).toEqual([35, 54])
  })

  it('remaps the Blob-backed indices written by the template store', async () => {
    const { abort, update } = await runMigration({
      id: 'template',
      indices: new Blob([Uint8Array.from([17, 54])]),
      appearance: { hiddenColours: [17] },
    })

    expect(abort).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
    const migrated = update.mock.calls[0]?.[0] as { indices: Blob; appearance: unknown }
    expect([...new Uint8Array(await migrated.indices.arrayBuffer())]).toEqual([19, 35])
    expect(migrated.appearance).toEqual({ hiddenColours: [19] })
  })

  it('skips a template record that cannot be migrated', async () => {
    const { abort, continueCursor, update } = await runMigration({
      id: 'template',
      indices: 'unreadable',
    })

    expect(update).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
    expect(continueCursor).toHaveBeenCalledOnce()
  })
})
