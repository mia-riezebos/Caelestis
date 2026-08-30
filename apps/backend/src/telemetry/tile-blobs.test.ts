import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { BlobStore, SqlStore, TileBlobReservation, TileObservation } from '../ports/index.js'
import {
  readTileBlob,
  reserveTileBlob,
  reserveTileBlobUpload,
  runTileBlobGc,
  TILE_BLOB_GC_DELETE_LIMIT,
  TILE_BLOB_GC_SCAN_LIMIT,
  type TileBlobGcMode,
} from './tile-blobs.js'

const TOKEN = 'a'.repeat(64)
const HASH = 'b'.repeat(64)
const BYTES = new Uint8Array([1, 2, 3])

const observation = (): TileObservation => ({
  season: 0,
  tile: { x: 1, y: 2 },
  hash: HASH,
  observedAt: millis(2_000),
  reportedAt: seconds(2),
  reportedWithToken: TOKEN,
  reportedByUserId: 7,
})

type Harness = {
  ports: { readonly sql: SqlStore; readonly blobs: BlobStore }
  sql: SqlStore
  blobs: MemoryBlobStore
  close(): void
}

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => {
      const sql = new MemorySqlStore()
      const blobs = new MemoryBlobStore()
      return {
        ports: { sql, blobs },
        sql,
        blobs,
        close: () => {},
      }
    },
  },
  {
    name: 'D1',
    make: () => {
      const database = new SqliteD1Database()
      const sql = new D1SqlStore(database as unknown as D1Database)
      const blobs = new MemoryBlobStore()
      return {
        ports: { sql, blobs },
        sql,
        blobs,
        close: () => database.close(),
      }
    },
  },
]

const commit = (sql: SqlStore, reservation: TileBlobReservation) =>
  sql.commitTileBlobReservation(reservation.id, millis(2_000), observation(), [])

const logger = { log: () => {}, error: () => {} }

const gc = (harness: Harness, mode: TileBlobGcMode, now: number) =>
  runTileBlobGc(harness.ports, { mode, now: millis(now), logger })

describe.each(adapters)('$name generation-fenced tile blobs', ({ make }) => {
  let harness: Harness

  beforeEach(() => {
    harness = make()
  })

  afterEach(() => harness.close())

  it('keeps a reference that arrives before the fence', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))

    const held = await reserveTileBlob(harness.ports, HASH, millis(1_500))
    expect(held).not.toBeNull()
    if (held === null) throw new Error('expected the legacy blob to be reserved')
    await expect(commit(harness.sql, held.reservation)).resolves.toBe(true)

    await expect(harness.sql.claimTileBlobDeletion(HASH, millis(3_000))).resolves.toBe('missing')
    await expect(readTileBlob(harness.ports, HASH)).resolves.toEqual(BYTES)
  })

  it('finishes an interrupted deletion before restoring during the fence', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))
    await harness.sql.claimTileBlobDeletion(HASH, millis(1_500))

    const reservation = await reserveTileBlobUpload(harness.ports, HASH, millis(2_000))
    expect(reservation.blobKey).not.toBe(HASH)
    await harness.blobs.put('tiles', reservation.blobKey, BYTES)
    await expect(commit(harness.sql, reservation)).resolves.toBe(true)

    await expect(harness.blobs.get('tiles', HASH)).resolves.toBeNull()
    await expect(readTileBlob(harness.ports, HASH)).resolves.toEqual(BYTES)
  })

  it('restores after deletion without reusing its physical key', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))
    await harness.sql.claimTileBlobDeletion(HASH, millis(1_500))
    await harness.blobs.delete('tiles', [HASH])
    await harness.sql.finishTileBlobDeletion(HASH, millis(1_600))

    const reservation = await reserveTileBlobUpload(harness.ports, HASH, millis(2_000))
    await harness.blobs.put('tiles', reservation.blobKey, BYTES)
    await expect(commit(harness.sql, reservation)).resolves.toBe(true)

    expect(reservation.blobKey).toMatch(new RegExp(`^${HASH}/`))
    await expect(readTileBlob(harness.ports, HASH)).resolves.toEqual(BYTES)
  })

  it('reuses an existing generation for duplicate uploads', async () => {
    const first = await reserveTileBlobUpload(harness.ports, HASH, millis(2_000))
    const duplicate = await reserveTileBlobUpload(harness.ports, HASH, millis(2_100))

    expect(duplicate.blobKey).toBe(first.blobKey)
  })

  it('keeps a late expired upload on the replacement generation', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))

    const stale = await reserveTileBlobUpload(harness.ports, HASH, millis(2_000))
    expect(stale.blobKey).not.toBe(HASH)

    await gc(harness, 'delete', 302_001)
    await expect(harness.blobs.get('tiles', HASH)).resolves.toBeNull()

    const retry = await reserveTileBlobUpload(harness.ports, HASH, millis(302_100))
    expect(retry.blobKey).toBe(stale.blobKey)
    await harness.blobs.put('tiles', retry.blobKey, BYTES)
    await expect(
      harness.sql.commitTileBlobReservation(retry.id, millis(302_200), observation(), []),
    ).resolves.toBe(true)

    // The first request finally completes after the retry. Both target one physical key.
    await harness.blobs.put('tiles', stale.blobKey, BYTES)
    await gc(harness, 'dry-run', 302_300)
    await expect(harness.blobs.list('tiles', { limit: 10 })).resolves.toEqual({
      keys: [retry.blobKey],
    })
  })

  it('keeps dry-run bounded, resumable and unable to delete', async () => {
    const hashes = Array.from({ length: TILE_BLOB_GC_SCAN_LIMIT + 2 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    )
    for (const hash of hashes) await harness.blobs.put('tiles', hash, BYTES)
    await harness.blobs.put('chunks', HASH, BYTES)

    const first = await gc(harness, 'dry-run', 1_000)
    expect(first).toMatchObject({
      scanned: TILE_BLOB_GC_SCAN_LIMIT,
      candidates: TILE_BLOB_GC_SCAN_LIMIT,
      queued: TILE_BLOB_GC_DELETE_LIMIT,
      reclaimed: 0,
      completedSweeps: 0,
    })
    expect(first.cursor).toBeDefined()
    const second = await gc(harness, 'dry-run', 2_000)
    expect(second).toMatchObject({ scanned: 2, candidates: 2, completedSweeps: 1 })
    await expect(harness.blobs.get('tiles', hashes[0] ?? '')).resolves.toEqual(BYTES)
    await expect(harness.blobs.get('chunks', HASH)).resolves.toEqual(BYTES)
  })

  it('recovers a crash after candidate creation', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await gc(harness, 'dry-run', 1_000)

    const report = await gc(harness, 'delete', 2_000)
    expect(report).toMatchObject({ reclaimed: 1, failed: 0 })
    await expect(harness.blobs.get('tiles', HASH)).resolves.toBeNull()
  })

  it('recovers a crash after fencing and before R2 deletion', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))
    await harness.sql.claimTileBlobDeletion(HASH, millis(1_100))

    const report = await gc(harness, 'delete', 2_000)
    expect(report).toMatchObject({ retries: 1, reclaimed: 1, failed: 0 })
    await expect(harness.blobs.get('tiles', HASH)).resolves.toBeNull()
  })

  it('recovers a crash after R2 deletion and before SQL finalization', async () => {
    await harness.blobs.put('tiles', HASH, BYTES)
    await harness.sql.noteTileBlobObject(HASH, HASH, millis(1_000))
    await harness.sql.claimTileBlobDeletion(HASH, millis(1_100))
    await harness.blobs.delete('tiles', [HASH])

    const report = await gc(harness, 'delete', 2_000)
    expect(report).toMatchObject({ retries: 1, reclaimed: 1, failed: 0 })
    await expect(harness.sql.listTileBlobDeletionWork(1)).resolves.toEqual([])
  })
})
