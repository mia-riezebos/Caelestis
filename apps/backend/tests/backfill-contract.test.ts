import {
  type ArchiveSnapshot,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  millis,
  type TileCoord,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { parseSnapshots } from '../src/backfill/eralyon.js'
import {
  type ArchiveSource,
  type BackfillStorage,
  TemplateBackfill,
} from '../src/backfill/import.js'

const templateId = '01890f3e-7b2c-7abc-8def-012345678901'
const versionId = '01890f3e-7b2c-7abc-8def-012345678902'
const chunkHash = 'a'.repeat(64)
const snapshot = { id: 1, at: 100 } satisfies ArchiveSnapshot

class MemoryBackfillStorage implements BackfillStorage {
  readonly alarms: number[] = []
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => [key, value as T]),
    )
  }

  async setAlarm(at: number): Promise<void> {
    this.alarms.push(at)
  }
}

const createImporter = async (archive: ArchiveSource) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  await blobs.put('chunks', chunkHash, await encodeIndexedPng(1, 1, new Uint8Array([1])))
  await sql.insertTemplateVersion({
    templateId,
    versionId,
    surface: WORLD_TEMPLATE_SURFACE,
    season: 0,
    nodeId: null,
    name: 'Archive mural',
    createdWithToken: 'b'.repeat(64),
    createdByUserId: null,
    createdAt: millis(1),
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: chunkHash }],
  })
  const storage = new MemoryBackfillStorage()
  return {
    importer: new TemplateBackfill(storage, sql, blobs, archive, () => 200_000),
    storage,
    sql,
    blobs,
  }
}

describe('template backfill contract', () => {
  it('reads the archive catalogue in chronological order without duplicate snapshots', () => {
    expect(
      parseSnapshots(
        "const WPLACE_VERSIONS = [{ version: '3' }, { version: '1' }, { version: '3' }]",
      ),
    ).toMatchObject([{ id: 1 }, { id: 3 }])
  })

  it('does not start archive work after cancellation', async () => {
    let reads = 0
    const { importer } = await createImporter({
      snapshots: async () => [snapshot],
      tile: async () => {
        reads++
        return new Uint8Array(1_000_000).fill(1)
      },
    })

    await importer.start(templateId, versionId, snapshot.id)
    await importer.cancel()
    await importer.step()

    expect(reads).toBe(0)
    expect(await importer.job()).toMatchObject({ status: 'cancelled', completed: 0 })
  })

  it('resumes persisted progress without fetching or crediting completed snapshots again', async () => {
    const reads: string[] = []
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id, tile) => {
        reads.push(`${id}:${tile.x}/${tile.y}`)
        return new Uint8Array(1_000_000).fill(id)
      },
    }
    const { importer, storage, sql, blobs } = await createImporter(archive)
    const job = await importer.start(templateId, versionId, snapshot.id)
    await importer.step()
    expect(await importer.job()).toMatchObject({ status: 'running', completed: 1 })

    const resumed = new TemplateBackfill(storage, sql, blobs, archive, () => 200_000)
    for (let step = 1; step < job.total; step++) await resumed.step()
    await resumed.step()
    expect(reads).toHaveLength(job.total)
    expect(new Set(reads).size).toBe(job.total)
    expect(await resumed.job()).toMatchObject({
      status: 'completed',
      imported: job.total,
      failed: 0,
    })
    expect(await resumed.history(versionId)).toMatchObject({
      samples: [
        { snapshotId: 1, correct: 1, mismatched: 0, total: 1 },
        { snapshotId: 2, correct: 0, mismatched: 1, total: 1 },
      ],
    })
    const stored = await blobs.list('archives', { limit: 10 })
    expect(stored.keys).toHaveLength(2)
    const colours = await Promise.all(
      stored.keys.map(async (key) => {
        const bytes = await blobs.get('archives', key)
        if (bytes === null) throw new Error('archive bytes were lost')
        const decoded = await decodeWplaceIndexedPng(bytes)
        if (decoded === null) throw new Error('archive pixels could not be decoded')
        expect([decoded.width, decoded.height]).toEqual([1000, 1000])
        return decoded.indices[0]
      }),
    )
    expect(colours.sort()).toEqual([1, 2])
  })

  it('records an unavailable archive tile as incomplete instead of inventing progress', async () => {
    const { importer } = await createImporter({
      snapshots: async () => [snapshot],
      tile: async (_snapshotId: number, _tile: TileCoord) => null,
    })

    const job = await importer.start(templateId, versionId, snapshot.id)
    for (let step = 0; step < job.total; step += 1) await importer.step()

    expect(await importer.job()).toMatchObject({
      status: 'completed',
      skipped: job.total,
      failed: 0,
    })
    expect(await importer.history(versionId)).toMatchObject({
      samples: [{ snapshotId: snapshot.id, correct: null, mismatched: null }],
    })
  })
})
