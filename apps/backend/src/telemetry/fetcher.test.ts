import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  tileKey,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { Ports, TemplateVersionRecord } from '../ports/index.js'
import { fetchAlarmFollowUps, fetchCanvasTiles, RING_STALENESS_SECONDS } from './fetcher.js'

const TOKEN = 'a'.repeat(64)
const NOW = seconds(1_750_032_000)

const version = (
  templateId: string,
  tiles: readonly { x: number; y: number }[],
): TemplateVersionRecord => ({
  templateId,
  surface: { kind: 'world', allianceId: null },
  season: 0,
  nodeId: null,
  name: templateId,
  versionId: `${templateId}-version`,
  createdWithToken: TOKEN,
  createdByUserId: null,
  createdAt: millis(1_000),
  bbox: {
    minX: Math.min(...tiles.map((t) => t.x)) * TILE_SIZE,
    minY: Math.min(...tiles.map((t) => t.y)) * TILE_SIZE,
    maxX: (Math.max(...tiles.map((t) => t.x)) + 1) * TILE_SIZE,
    maxY: (Math.max(...tiles.map((t) => t.y)) + 1) * TILE_SIZE,
  },
  totalPixels: 1,
  chunks: tiles.map((tile, index) => ({
    tileX: tile.x,
    tileY: tile.y,
    hash: String(index % 10).repeat(64),
  })),
})

/** A wplace-shaped canvas tile whose bytes vary with `seed`, so hashes differ on demand. */
const tileBytes = async (seed: number): Promise<Uint8Array> => {
  const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  indices[seed % indices.length] = 1
  return encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
}

const harness = () => {
  const blobs = new MemoryBlobStore()
  const sql = new MemorySqlStore()
  const counters = new MemoryCounterStore(sql, () => millis(NOW * 1_000))
  const ports: Ports = { blobs, sql, counters }
  const requested: string[] = []
  const userAgents: (string | null)[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    userAgents.push(new Headers(init?.headers).get('user-agent'))
    const match = url.match(/tiles\/(\d+)\/(\d+)\.png$/)
    if (match === null) return new Response(null, { status: 404 })
    const body = await tileBytes(Number(match[1]) * 7 + Number(match[2]))
    return new Response(body.slice())
  }) as typeof fetch
  return { ports, sql, requested, userAgents, fetchImpl }
}

describe('the 6-hour tile fetcher', () => {
  it('fetches each tile once even when templates overlap, plus a deduplicated ring', async () => {
    const { ports, sql, requested, userAgents, fetchImpl } = harness()
    // Two templates on the same tile, one a neighbour — the shared tile must fetch exactly once.
    await sql.insertTemplateVersion(version('overlap-a', [{ x: 100, y: 100 }]))
    await sql.insertTemplateVersion(version('overlap-b', [{ x: 100, y: 100 }]))
    await sql.insertTemplateVersion(version('neighbour', [{ x: 101, y: 100 }]))

    const report = await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })

    expect(new Set(requested).size).toBe(requested.length)
    expect(new Set(userAgents)).toEqual(new Set(['Caelestis-Tile-Fetcher/1.0']))
    // 2 template tiles + the ring around a 2×1 block: a 4×3 rectangle of tiles in total.
    expect(requested).toHaveLength(12)
    expect(report).toMatchObject({ fetched: 12, unchanged: 0, fresh: 0, failed: 0, deferred: 0 })
    // Ring tiles are recorded even though no template covers them, and template tiles land as
    // observations like any reporter upload. (Status classification against chunk blobs is the
    // ingest tests' business — these fixtures deliberately store no chunk bytes.)
    await expect(sql.readLatestTile(0, { x: 99, y: 99 })).resolves.not.toBeNull()
    await expect(sql.readLatestTile(0, { x: 100, y: 100 })).resolves.not.toBeNull()
  })

  it('skips unchanged tiles entirely and leaves fresh ring tiles alone', async () => {
    const { ports, sql, requested, fetchImpl } = harness()
    await sql.insertTemplateVersion(version('lone', [{ x: 5, y: 5 }]))

    const first = await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })
    expect(first.fetched).toBe(9)

    // A second run soon after: the template tile is refetched but its bytes have not changed, so
    // nothing new is stored; ring tiles are still fresh and are not even requested.
    requested.length = 0
    const second = await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 21_600),
      fetchImpl,
    })
    expect(second).toMatchObject({ fetched: 0, unchanged: 1, fresh: 8, failed: 0 })
    expect(requested).toHaveLength(1)
    expect(requested[0]).toContain(`tiles/5/5.png`)

    // Once the ring goes stale it is fetched again — and being unchanged, still stores nothing.
    requested.length = 0
    const third = await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 21_600 + RING_STALENESS_SECONDS),
      fetchImpl,
    })
    expect(third).toMatchObject({ fetched: 0, unchanged: 9, fresh: 0 })
  })

  it('survives an upstream failure without abandoning the run', async () => {
    const { ports, sql } = harness()
    await sql.insertTemplateVersion(version('lone', [{ x: 5, y: 5 }]))
    let calls = 0
    const flaky = (async () => {
      calls++
      if (calls === 1) throw new Error('connection reset')
      return new Response(null, { status: 502 })
    }) as typeof fetch

    const report = await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl: flaky })
    expect(report).toMatchObject({ fetched: 0, failed: 9 })
    expect(await ports.sql.readLatestTile(0, { x: 5, y: 5 })).toBeNull()
  })

  it('spends its budget on template tiles before any ring tile', async () => {
    const { ports, sql, requested, fetchImpl } = harness()
    // 250 distinct template tiles: over the 200-tile budget before the ring is even considered.
    const tiles = Array.from({ length: 250 }, (_, i) => ({
      x: 10 + (i % 50),
      y: 10 + Math.floor(i / 50),
    }))
    await sql.insertTemplateVersion(version('wide', tiles))

    const report = await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })
    expect(report.fetched).toBe(200)
    expect(report.deferred).toBeGreaterThan(0)
    const templateKeys = new Set<string>(tiles.map((tile) => tileKey(tile)))
    for (const url of requested) {
      const match = url.match(/tiles\/(\d+)\/(\d+)\.png$/)
      expect(templateKeys.has(`${match?.[1] ?? ''}/${match?.[2] ?? ''}`)).toBe(true)
    }
  }, 20_000)

  it('opens on a six-hour regression and promotes only after a worsening follow-up', async () => {
    const { ports, sql } = harness()
    const chunk = await encodeIndexedPng(20, 1, new Uint8Array(20).fill(1))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    await sql.insertTemplateVersion({
      ...version('watched', [{ x: 5, y: 5 }]),
      versionId: 'watched-version',
      bbox: {
        minX: 5 * TILE_SIZE,
        minY: 5 * TILE_SIZE,
        maxX: 5 * TILE_SIZE + 20,
        maxY: 5 * TILE_SIZE + 1,
      },
      totalPixels: 20,
      chunks: [{ tileX: 5, tileY: 5, hash }],
    })
    await sql.setTemplatePublishedAt('watched', millis(NOW * 1_000), millis(NOW * 1_000))

    let lost = 0
    const canvas = async () => {
      const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
      indices.fill(1, 0, 20 - lost)
      return encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
    }
    const fetchImpl = (async () => new Response((await canvas()).slice())) as typeof fetch

    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })
    lost = 10
    const scanAt = seconds(NOW + 6 * 60 * 60)
    const scan = await fetchCanvasTiles(ports, {
      season: 0,
      now: scanAt,
      fetchImpl,
      alarmIdFactory: () => 'alarm-1',
    })
    expect(scan.followUpScheduled).toBe(true)
    await expect(sql.readActiveAlarms(0, false)).resolves.toEqual([
      expect.objectContaining({ id: 'alarm-1', kind: 'regression', pixelsLost: 10 }),
    ])

    lost = 11
    const followAt = seconds(scanAt + 10 * 60)
    const probes = await sql.listDueAlarmProbes(millis(followAt * 1_000))
    await expect(fetchAlarmFollowUps(ports, probes, { now: followAt, fetchImpl })).resolves.toEqual(
      {
        evaluated: 1,
        failed: 0,
      },
    )
    await expect(sql.readActiveAlarms(0, false)).resolves.toEqual([
      expect.objectContaining({ kind: 'sustained-griefing', pixelsLost: 11 }),
    ])
  }, 20_000)
})
