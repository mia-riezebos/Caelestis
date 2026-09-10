import {
  type ArchiveSnapshot,
  encodeIndexedPng,
  millis,
  seconds,
  TILE_SIZE,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { type BackfillStorage, TemplateBackfill } from './import.js'

class Storage implements BackfillStorage {
  values = new Map<string, unknown>()
  alarm = 0
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value))
  }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b)),
    ) as Map<string, T>
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at
  }
}

const snapshots: readonly ArchiveSnapshot[] = [
  { id: 10, at: 100 },
  { id: 20, at: 200 },
]
const setup = async () => {
  const storage = new Storage(),
    sql = new MemorySqlStore(),
    blobs = new MemoryBlobStore()
  const target = new Uint8Array(2)
  target[0] = 0
  target[1] = 1
  await blobs.put('chunks', 'b'.repeat(64), await encodeIndexedPng(2, 1, target))
  await sql.insertTemplateVersion({
    templateId: 'template',
    versionId: 'version',
    season: 0,
    nodeId: null,
    name: 'Test',
    surface: { kind: 'world', allianceId: null },
    createdAt: millis(300_000),
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    bbox: { minX: 20, minY: 30, maxX: 22, maxY: 31 },
    totalPixels: 2,
    chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
  })
  let missing = false,
    failure = false
  let calls = 0
  const archive = {
    snapshots: async () => snapshots,
    tile: async (id: number) => {
      calls++
      if (failure) throw new Error('Archive offline')
      if (missing) return null
      const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
      pixels[30 * TILE_SIZE + 20] = 0
      if (id === 20) pixels[30 * TILE_SIZE + 21] = 1
      return pixels
    },
  }
  const engine = new TemplateBackfill(storage, sql, blobs, archive, () => 400_000)
  const finish = async () => {
    while ((await engine.job())?.status === 'running') await engine.step()
  }
  return {
    engine,
    storage,
    sql,
    blobs,
    finish,
    calls: () => calls,
    missing: () => {
      missing = true
    },
    fail: (value: boolean) => {
      failure = value
    },
  }
}

it('imports complete sparse observations before creation without changing live state; retries reuse tiles', async () => {
  const h = await setup()
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect((await h.engine.history('version')).samples.map((sample) => sample.correct)).toEqual([
    1, 2,
  ])
  expect((await h.sql.readTemplate('template'))?.createdAt).toBe(300_000)
  const calls = h.calls()
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect(h.calls()).toBe(calls)
  expect((await h.engine.history('version', { x: 0, y: 0 })).frames).toHaveLength(2)
  expect((await h.engine.job())?.imported).toBe(0)
})

it('keeps incomplete coverage as gaps and allows cancellation between durable units', async () => {
  const h = await setup()
  h.missing()
  await h.engine.start('template', 'version', 10)
  await h.engine.step()
  await h.engine.cancel()
  await h.engine.step()
  expect((await h.engine.job())?.completed).toBe(1)
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect(
    (await h.engine.history('version')).samples.every((sample) => sample.correct === null),
  ).toBe(true)
})

it('retries failed units and refuses a stale artwork selection', async () => {
  const h = await setup()
  h.fail(true)
  await expect(h.engine.start('template', 'old-version', 10)).rejects.toThrow('artwork changed')
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect((await h.engine.job())?.status).toBe('failed')
  h.fail(false)
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect((await h.engine.history('version')).samples.map((sample) => sample.correct)).toEqual([
    1, 2,
  ])
})

it('keeps start retryable when the first alarm cannot be scheduled', async () => {
  const h = await setup()
  vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('Scheduling unavailable'))
  await expect(h.engine.start('template', 'version', 10)).rejects.toThrow('Scheduling unavailable')
  expect((await h.engine.preview('template')).job).toBeNull()
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect((await h.engine.job())?.status).toBe('completed')
})

const observeLive = (sql: MemorySqlStore, at: number) =>
  sql.recordTileObservation(
    {
      season: 0,
      tile: { x: 0, y: 0 },
      hash: 'd'.repeat(64),
      observedAt: millis(at * 1000),
      reportedAt: seconds(at),
      reportedWithToken: 'a'.repeat(64),
      reportedByUserId: 1,
    },
    [],
  )

it('excludes snapshots at and after the first native observation from preview and new imports', async () => {
  const h = await setup()
  await observeLive(h.sql, 200)
  expect((await h.engine.preview('template')).snapshots.map((snapshot) => snapshot.at)).toEqual([
    100,
  ])
  await h.engine.start('template', 'version', 10)
  await h.finish()
  expect(h.calls()).toBe(1)
})

it('stops an existing job when native history arrives and hides previously imported overlaps', async () => {
  const h = await setup()
  await h.engine.start('template', 'version', 10)
  await h.finish()
  await h.engine.start('template', 'version', 10)
  await h.engine.step()
  await observeLive(h.sql, 200)
  await h.finish()
  expect(await h.engine.job()).toMatchObject({
    status: 'completed',
    completed: 1,
    total: 1,
    to: 100,
  })
  expect((await h.engine.history('version')).samples.map((sample) => sample.at)).toEqual([100])
  expect(
    (await h.engine.history('version', { x: 0, y: 0 })).frames.map((frame) => frame.at),
  ).toEqual([100])
})
