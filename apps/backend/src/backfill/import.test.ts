import {
  type ArchiveSnapshot,
  encodeIndexedPng,
  millis,
  TILE_SIZE,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { expect, it } from 'vitest'
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
  const target = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  target[0] = 0
  target[1] = 1
  await blobs.put('chunks', 'b'.repeat(64), await encodeIndexedPng(TILE_SIZE, TILE_SIZE, target))
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
    bbox: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
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
      pixels[0] = 0
      if (id === 20) pixels[1] = 1
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
