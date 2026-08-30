import { millis, seconds } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { Ports, SqlStore, TileBlobReservation, TileObservation } from '../ports/index.js'
import { readTileBlob, reserveTileBlob, reserveTileBlobUpload } from './tile-blobs.js'

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

type Harness = { ports: Ports; sql: SqlStore; blobs: MemoryBlobStore; close(): void }

const adapters: readonly { name: string; make(): Harness }[] = [
  {
    name: 'memory',
    make: () => {
      const sql = new MemorySqlStore()
      const blobs = new MemoryBlobStore()
      return {
        ports: { sql, blobs, counters: {} as Ports['counters'] },
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
        ports: { sql, blobs, counters: {} as Ports['counters'] },
        sql,
        blobs,
        close: () => database.close(),
      }
    },
  },
]

const commit = (sql: SqlStore, reservation: TileBlobReservation) =>
  sql.commitTileBlobReservation(reservation.id, millis(2_000), observation(), [])

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
})
