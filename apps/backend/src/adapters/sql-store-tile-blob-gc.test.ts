import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqlStore, TileObservation } from '../ports/index.js'
import { D1SqlStore } from './cloudflare/d1-sql-store.js'
import { SqliteD1Database } from './cloudflare/sqlite-d1.test-helper.js'
import { MemorySqlStore } from './memory/memory-sql-store.js'

const TOKEN = 'a'.repeat(64)
const HASH = 'b'.repeat(64)
const OTHER_HASH = 'c'.repeat(64)

const observation = (hash: string, observedAt = millis(2_000)): TileObservation => ({
  season: 0,
  tile: { x: 1, y: 2 },
  hash,
  observedAt,
  reportedAt: seconds(Math.floor(observedAt / 1_000)),
  reportedWithToken: TOKEN,
  reportedByUserId: 7,
})

type Harness = { store: SqlStore; close(): void }

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => ({ store: new MemorySqlStore(), close: () => undefined }),
  },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      return {
        store: new D1SqlStore(database as unknown as D1Database),
        close: () => database.close(),
      }
    },
  },
]

describe.each(adapters)('$name tile blob lifecycle contract', ({ make }) => {
  let harness: Harness
  let store: SqlStore

  beforeEach(() => {
    harness = make()
    store = harness.store
  })

  afterEach(() => harness.close())

  it('persists candidate, fence, retry and finalization phases', async () => {
    await expect(store.noteTileBlobObject(HASH, HASH, millis(1_000))).resolves.toBe('candidate')
    await expect(store.claimTileBlobDeletion(HASH, millis(2_000))).resolves.toBe('claimed')
    await expect(store.listTileBlobDeletionWork(1)).resolves.toEqual([
      expect.objectContaining({
        blobKey: HASH,
        state: 'deleting',
        deleteAttempts: 1,
        deleteStartedAt: millis(2_000),
      }),
    ])

    await expect(store.claimTileBlobDeletion(HASH, millis(3_000))).resolves.toBe('claimed')
    await expect(store.listTileBlobDeletionWork(1)).resolves.toEqual([
      expect.objectContaining({ state: 'deleting', deleteAttempts: 2 }),
    ])

    await store.finishTileBlobDeletion(HASH, millis(4_000))
    await expect(store.listTileBlobDeletionWork(1)).resolves.toEqual([])
  })

  it('lets tile_history independently block a stale candidate', async () => {
    await store.noteTileBlobObject(HASH, HASH, millis(1_000))
    await store.recordTileObservation(observation(HASH), [])
    await store.recordTileObservation(observation(OTHER_HASH, millis(3_000)), [], false)

    await expect(store.claimTileBlobDeletion(HASH, millis(4_000))).resolves.toBe('blocked')
  })

  it('lets canvas_tiles independently block a stale candidate', async () => {
    await store.noteTileBlobObject(HASH, HASH, millis(1_000))
    await store.recordTileObservation(observation(HASH), [], false)

    await expect(store.claimTileBlobDeletion(HASH, millis(4_000))).resolves.toBe('blocked')
  })

  it('admits a reservation before the fence and expires it deterministically', async () => {
    await store.noteTileBlobObject(HASH, HASH, millis(1_000))
    await expect(
      store.reserveTileBlob(HASH, 'reservation', millis(2_000), millis(3_000)),
    ).resolves.toEqual({
      id: 'reservation',
      hash: HASH,
      blobKey: HASH,
      expiresAt: millis(3_000),
    })
    await expect(store.noteTileBlobObject(HASH, HASH, millis(2_500))).resolves.toBe('referenced')

    await expect(store.noteTileBlobObject(HASH, HASH, millis(3_000))).resolves.toBe('candidate')
    await expect(store.claimTileBlobDeletion(HASH, millis(3_000))).resolves.toBe('claimed')
  })

  it('blocks references during deletion and restores into a new physical generation', async () => {
    await store.noteTileBlobObject(HASH, HASH, millis(1_000))
    await store.claimTileBlobDeletion(HASH, millis(2_000))
    await expect(
      store.reserveTileBlob(HASH, 'during', millis(2_500), millis(3_500)),
    ).resolves.toBeNull()

    await store.finishTileBlobDeletion(HASH, millis(3_000))
    const blobKey = `${HASH}/01890f3a-6b7c-7def-8123-456789abcdef`
    await expect(
      store.reserveTileBlobUpload(HASH, blobKey, 'after', millis(3_100), millis(4_100)),
    ).resolves.toEqual({
      id: 'after',
      hash: HASH,
      blobKey,
      expiresAt: millis(4_100),
    })
    await expect(
      store.commitTileBlobReservation('after', millis(3_200), observation(HASH, millis(3_200)), []),
    ).resolves.toEqual({ revision: null, statusChanges: [] })
    await expect(store.readTileBlob(HASH)).resolves.toMatchObject({
      blobKey,
      state: 'active',
    })
  })

  it('reuses one unfenced generation across duplicate upload reservations', async () => {
    const firstBlobKey = `${HASH}/01890f3a-6b7c-7def-8123-456789abcdef`
    const duplicateBlobKey = `${HASH}/01890f3a-6b7c-7def-8123-456789abcdee`

    await expect(
      store.reserveTileBlobUpload(HASH, firstBlobKey, 'first', millis(1_000), millis(3_000)),
    ).resolves.toMatchObject({ blobKey: firstBlobKey })
    await expect(
      store.reserveTileBlobUpload(
        HASH,
        duplicateBlobKey,
        'duplicate',
        millis(1_100),
        millis(3_100),
      ),
    ).resolves.toMatchObject({ blobKey: firstBlobKey })
  })

  it('does not attach a new upload to a reclaimable candidate', async () => {
    const uploadBlobKey = `${HASH}/01890f3a-6b7c-7def-8123-456789abcdef`
    await store.noteTileBlobObject(HASH, HASH, millis(1_000))

    await expect(
      store.reserveTileBlobUpload(HASH, uploadBlobKey, 'upload', millis(1_100), millis(3_100)),
    ).resolves.toMatchObject({ blobKey: uploadBlobKey })
    await expect(
      store.commitTileBlobReservation(
        'upload',
        millis(1_200),
        observation(HASH, millis(1_200)),
        [],
      ),
    ).resolves.toEqual({ revision: null, statusChanges: [] })

    await expect(store.noteTileBlobObject(HASH, HASH, millis(1_300))).resolves.toBe('candidate')
    await expect(store.claimTileBlobDeletion(HASH, millis(1_400))).resolves.toBe('claimed')
  })

  it('persists the bounded R2 scan cursor and completed sweeps', async () => {
    await expect(store.readTileBlobScanState()).resolves.toEqual({ completedSweeps: 0 })
    await store.writeTileBlobScanState('cursor-1')
    await expect(store.readTileBlobScanState()).resolves.toEqual({
      cursor: 'cursor-1',
      completedSweeps: 0,
    })
    await store.writeTileBlobScanState(undefined)
    await expect(store.readTileBlobScanState()).resolves.toEqual({ completedSweeps: 1 })
  })
})
