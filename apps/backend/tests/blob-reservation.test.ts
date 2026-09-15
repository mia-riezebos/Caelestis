import { millis } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { reserveTileBlob, runTileBlobGc } from '../src/telemetry/tile-blobs.js'
import { openRelationalStore } from './support/relational.js'

it.each(['memory', 'sqlite'])(
  '%s keeps reserved blobs through GC and reclaims them after release',
  async (adapter) => {
    const handle = adapter === 'sqlite' ? await openRelationalStore() : null
    const sql = handle?.sql ?? new MemorySqlStore()
    try {
      const blobs = new MemoryBlobStore()
      const hash = 'c'.repeat(64)
      const bytes = new Uint8Array([3])
      await blobs.put('tiles', hash, bytes)

      expect(
        (await runTileBlobGc({ sql, blobs }, { mode: 'dry-run', now: millis(10) })).candidates,
      ).toBe(1)
      const held = await reserveTileBlob({ sql, blobs }, hash, millis(11))
      expect(held?.bytes).toEqual(bytes)

      expect(
        (await runTileBlobGc({ sql, blobs }, { mode: 'delete', now: millis(12) })).reclaimed,
      ).toBe(0)
      expect(await blobs.get('tiles', hash)).toEqual(bytes)

      if (held === null) throw new Error('tile blob reservation unexpectedly failed')
      await sql.releaseTileBlobReservation(held.reservation.id)
      expect(
        (await runTileBlobGc({ sql, blobs }, { mode: 'delete', now: millis(13) })).reclaimed,
      ).toBe(1)
      expect(await blobs.get('tiles', hash)).toBeNull()
    } finally {
      await handle?.close()
    }
  },
)
