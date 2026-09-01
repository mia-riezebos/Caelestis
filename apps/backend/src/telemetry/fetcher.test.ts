import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  tileKey,
} from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import type { TemplateVersionRecord } from '../ports/index.js'
import { DirectStatusReadModel, type StatusReadModelPort } from '../status-read-model/port.js'
import {
  type FetcherStores,
  fetchAlarmFollowUps,
  fetchCanvasTiles,
  RING_STALENESS_SECONDS,
} from './fetcher.js'

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
  const direct = new DirectStatusReadModel(sql)
  const notifyAlarmChange = vi.fn(async () => undefined)
  const statusReadModel: StatusReadModelPort = {
    applyCommittedChange: (season, mutation) => direct.applyCommittedChange(season, mutation),
    reconcileSnapshot: (season, scope) => direct.reconcileSnapshot(season, scope),
    readManifestProjection: (input) => direct.readManifestProjection(input),
    notifyManifestChange: (season) => direct.notifyManifestChange(season),
    notifyAlarmChange,
    resolveCurrentTileOffers: (season, scope, offers) =>
      direct.resolveCurrentTileOffers(season, scope, offers),
    prepareTileGenerationCommit: (season, tile) => direct.prepareTileGenerationCommit(season, tile),
    applyCommittedTileGeneration: (season, generation) =>
      direct.applyCommittedTileGeneration(season, generation),
    finishTileGenerationCommit: (season, tile, commit) =>
      direct.finishTileGenerationCommit(season, tile, commit),
  }
  const ports = { blobs, sql, counters, statusReadModel }
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
  return { ports, sql, requested, userAgents, fetchImpl, notifyAlarmChange }
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
    const blobPut = vi.spyOn(ports.blobs, 'put')
    const second = await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 21_600),
      fetchImpl,
    })
    expect(second).toMatchObject({ fetched: 0, unchanged: 1, fresh: 8, failed: 0 })
    expect(requested).toHaveLength(1)
    expect(requested[0]).toContain(`tiles/5/5.png`)
    expect(blobPut).not.toHaveBeenCalled()

    // Once the ring goes stale it is fetched again — and being unchanged, still stores nothing.
    requested.length = 0
    const third = await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 21_600 + RING_STALENESS_SECONDS),
      fetchImpl,
    })
    expect(third).toMatchObject({ fetched: 0, unchanged: 9, fresh: 0 })
  })

  it('removes the cached generation before an authoritative replacement finishes', async () => {
    const { ports, sql } = harness()
    const tile = { x: 5, y: 5 }
    await sql.insertTemplateVersion(version('lone', [tile]))
    const oldBytes = await tileBytes(1)
    const newBytes = await tileBytes(2)
    const oldHash = await sha256Hex(oldBytes)
    const newHash = await sha256Hex(newBytes)
    const offer = (deliveryId: string, hash: string) => [{ deliveryId, tile, hash }]
    const fetchOld = (async () => new Response(oldBytes.slice())) as typeof fetch

    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl: fetchOld, maxTiles: 1 })
    await expect(
      ports.statusReadModel.resolveCurrentTileOffers?.(0, 'admin', offer('old', oldHash)),
    ).resolves.toMatchObject({ acknowledgedDeliveryIds: ['old'] })

    let releaseRepair: () => void = () => {}
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = () => resolve()
    })
    let repairStarted: () => void = () => {}
    const repairStart = new Promise<void>((resolve) => {
      repairStarted = () => resolve()
    })
    const apply = ports.statusReadModel?.applyCommittedTileGeneration
    if (apply === undefined) throw new Error('tile generation repair is not configured')
    vi.spyOn(ports.statusReadModel, 'applyCommittedTileGeneration').mockImplementation(
      async (season, generation) => {
        repairStarted()
        await repairGate
        await apply(season, generation)
      },
    )

    const replacing = fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 1),
      fetchImpl: (async () => new Response(newBytes.slice())) as typeof fetch,
      maxTiles: 1,
    })
    await repairStart

    await expect(
      ports.statusReadModel.resolveCurrentTileOffers?.(0, 'admin', offer('old', oldHash)),
    ).resolves.toMatchObject({ acknowledgedDeliveryIds: [], unresolvedDeliveryIds: ['old'] })
    releaseRepair()
    await replacing
    await expect(
      ports.statusReadModel.resolveCurrentTileOffers?.(0, 'admin', offer('new', newHash)),
    ).resolves.toMatchObject({ acknowledgedDeliveryIds: ['new'] })
  })

  it('applies all status changes from one fetch job in one projection call', async () => {
    const { ports, sql, fetchImpl } = harness()
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    for (const x of [5, 6]) {
      await sql.insertTemplateVersion({
        ...version(`tile-${x}`, [{ x, y: 5 }]),
        bbox: {
          minX: x * TILE_SIZE,
          minY: 5 * TILE_SIZE,
          maxX: x * TILE_SIZE + 1,
          maxY: 5 * TILE_SIZE + 1,
        },
        chunks: [{ tileX: x, tileY: 5, hash }],
      })
    }
    const applyCommittedChange = vi.fn(async () => null)
    const statusReadModel: StatusReadModelPort = {
      applyCommittedChange,
      reconcileSnapshot: vi.fn(),
    }

    await fetchCanvasTiles(
      { ...ports, statusReadModel },
      {
        season: 0,
        now: NOW,
        fetchImpl,
        maxTiles: 2,
      },
    )

    expect(applyCommittedChange).toHaveBeenCalledTimes(1)
    expect(applyCommittedChange).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ baseRevision: 0, revision: 2 }),
    )
  })

  it('flushes committed projection changes when a later fetch-job read aborts', async () => {
    const { ports, sql, fetchImpl } = harness()
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    await sql.insertTemplateVersion({
      ...version('first', [{ x: 5, y: 5 }]),
      bbox: {
        minX: 5 * TILE_SIZE,
        minY: 5 * TILE_SIZE,
        maxX: 5 * TILE_SIZE + 1,
        maxY: 5 * TILE_SIZE + 1,
      },
      chunks: [{ tileX: 5, tileY: 5, hash }],
    })
    const applyCommittedChange = vi.fn(async () => null)
    const statusReadModel: StatusReadModelPort = {
      applyCommittedChange,
      reconcileSnapshot: vi.fn(),
    }
    const readLatestTile = sql.readLatestTile.bind(sql)
    let reads = 0
    vi.spyOn(sql, 'readLatestTile').mockImplementation(async (...args) => {
      reads++
      if (reads === 2) throw new Error('D1 read failed')
      return readLatestTile(...args)
    })

    await expect(
      fetchCanvasTiles(
        { ...ports, statusReadModel },
        { season: 0, now: NOW, fetchImpl, maxTiles: 2 },
      ),
    ).rejects.toThrow('D1 read failed')
    expect(applyCommittedChange).toHaveBeenCalledTimes(1)
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

  it('does not evaluate a stale snapshot when this scan failed to refresh its tile', async () => {
    const { ports, sql, fetchImpl } = harness()
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    await sql.insertTemplateVersion({
      ...version('stale', [{ x: 5, y: 5 }]),
      bbox: {
        minX: 5 * TILE_SIZE,
        minY: 5 * TILE_SIZE,
        maxX: 5 * TILE_SIZE + 1,
        maxY: 5 * TILE_SIZE + 1,
      },
      chunks: [{ tileX: 5, tileY: 5, hash }],
    })
    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })
    const evaluate = vi.spyOn(sql, 'evaluateTemplateAlarm')

    await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 6 * 60 * 60),
      fetchImpl: (async () => new Response(null, { status: 502 })) as typeof fetch,
    })

    expect(evaluate).not.toHaveBeenCalled()
  })

  it('uses the authoritative fetch when a client observation is future-dated', async () => {
    const { ports, sql } = harness()
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    await sql.insertTemplateVersion({
      ...version('clock-skewed', [{ x: 5, y: 5 }]),
      bbox: {
        minX: 5 * TILE_SIZE,
        minY: 5 * TILE_SIZE,
        maxX: 5 * TILE_SIZE + 1,
        maxY: 5 * TILE_SIZE + 1,
      },
      chunks: [{ tileX: 5, tileY: 5, hash }],
    })
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 5, y: 5 },
        hash: 'f'.repeat(64),
        observedAt: millis((NOW + 5 * 60) * 1_000),
        reportedAt: seconds(NOW + 5 * 60),
        reportedWithToken: TOKEN,
        reportedByUserId: 1,
      },
      [
        {
          templateId: 'clock-skewed',
          versionId: 'clock-skewed-version',
          tile: { x: 5, y: 5 },
          correct: 0,
          wrong: 1,
          blank: 0,
          observedAt: millis((NOW + 5 * 60) * 1_000),
        },
      ],
    )
    const canvas = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    canvas[0] = 1
    const bytes = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, canvas)
    const evaluate = vi.spyOn(sql, 'evaluateTemplateAlarm')
    const record = vi
      .spyOn(sql, 'commitTileBlobReservation')
      .mockRejectedValueOnce(new Error('status write failed'))

    await fetchCanvasTiles(ports, {
      season: 0,
      now: NOW,
      fetchImpl: (async () => new Response(bytes.slice())) as typeof fetch,
    })
    expect(evaluate).not.toHaveBeenCalled()

    record.mockRestore()
    const serverNow = seconds(NOW + 1)
    await fetchCanvasTiles(ports, {
      season: 0,
      now: serverNow,
      fetchImpl: (async () => new Response(bytes.slice())) as typeof fetch,
    })

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'clock-skewed', correct: 1 }),
      { kind: 'scan' },
      expect.any(String),
    )
    await expect(sql.readLatestTile(0, { x: 5, y: 5 })).resolves.toMatchObject({
      observedAt: serverNow * 1_000,
    })
  })

  it('spends its budget on template tiles before any ring tile', async () => {
    const { ports, sql, requested, fetchImpl } = harness()
    // 150 distinct template tiles: over the conservative budget before the ring is considered.
    const tiles = Array.from({ length: 150 }, (_, i) => ({
      x: 10 + (i % 50),
      y: 10 + Math.floor(i / 50),
    }))
    await sql.insertTemplateVersion(version('wide', tiles))

    const report = await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })
    expect(report.fetched).toBe(100)
    expect(report.deferred).toBeGreaterThan(0)
    const templateKeys = new Set<string>(tiles.map((tile) => tileKey(tile)))
    for (const url of requested) {
      const match = url.match(/tiles\/(\d+)\/(\d+)\.png$/)
      expect(templateKeys.has(`${match?.[1] ?? ''}/${match?.[2] ?? ''}`)).toBe(true)
    }
  }, 20_000)

  it('rotates the budget onto stale tiles and evaluates a template larger than one batch', async () => {
    const { ports, sql } = harness()
    const tiles = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
    ]
    const chunkIndices = new Uint8Array(TILE_SIZE).fill(TRANSPARENT_INDEX)
    chunkIndices[0] = 1
    const chunk = await encodeIndexedPng(TILE_SIZE, 1, chunkIndices)
    const chunkHash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', chunkHash, chunk)
    await sql.insertTemplateVersion({
      ...version('wide-watched', tiles),
      totalPixels: 3,
      bbox: {
        minX: 10 * TILE_SIZE,
        minY: 10 * TILE_SIZE,
        maxX: 13 * TILE_SIZE,
        maxY: 10 * TILE_SIZE + 1,
      },
      chunks: tiles.map((tile) => ({ tileX: tile.x, tileY: tile.y, hash: chunkHash })),
    })
    const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    indices[0] = 1
    const canvas = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
    const fetchImpl = (async () => new Response(canvas.slice())) as typeof fetch
    const evaluate = vi.spyOn(sql, 'evaluateTemplateAlarm')

    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl, maxTiles: 2 })
    expect(evaluate).not.toHaveBeenCalled()

    await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 6 * 60 * 60 + 1),
      fetchImpl,
      maxTiles: 2,
    })
    expect(await sql.readTemplateStatuses(0, true)).toEqual([
      expect.objectContaining({ templateId: 'wide-watched', total: 3, correct: 3 }),
    ])
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'wide-watched', total: 3, correct: 3 }),
      { kind: 'scan' },
      expect.any(String),
    )
  }, 20_000)

  it('opens on a six-hour regression and promotes only after a worsening follow-up', async () => {
    const { ports, sql, notifyAlarmChange } = harness()
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
    notifyAlarmChange.mockClear()
    lost = 10
    const scanAt = seconds(NOW + 6 * 60 * 60)
    const scan = await fetchCanvasTiles(ports, {
      season: 0,
      now: scanAt,
      fetchImpl,
      alarmIdFactory: () => 'alarm-1',
    })
    expect(scan.followUpScheduled).toBe(true)
    expect(notifyAlarmChange).toHaveBeenCalledOnce()
    expect(notifyAlarmChange).toHaveBeenCalledWith(0)
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
        pending: 0,
      },
    )
    expect(notifyAlarmChange).toHaveBeenCalledTimes(2)
    await expect(sql.readActiveAlarms(0, false)).resolves.toEqual([
      expect.objectContaining({ kind: 'sustained-griefing', pixelsLost: 11 }),
    ])
  }, 20_000)

  it('continues a large follow-up across bounded batches before promoting it', async () => {
    const { ports, sql } = harness()
    const tiles = [
      { x: 20, y: 20 },
      { x: 21, y: 20 },
    ]
    const chunkIndices = new Uint8Array(TILE_SIZE).fill(TRANSPARENT_INDEX)
    chunkIndices.fill(1, 0, 10)
    const chunk = await encodeIndexedPng(TILE_SIZE, 1, chunkIndices)
    const chunkHash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', chunkHash, chunk)
    await sql.insertTemplateVersion({
      ...version('wide-follow-up', tiles),
      totalPixels: 20,
      bbox: {
        minX: 20 * TILE_SIZE,
        minY: 20 * TILE_SIZE,
        maxX: 22 * TILE_SIZE,
        maxY: 20 * TILE_SIZE + 1,
      },
      chunks: tiles.map((tile) => ({ tileX: tile.x, tileY: tile.y, hash: chunkHash })),
    })
    const painted = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    painted.fill(1, 0, 10)
    const paintedCanvas = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, painted)
    const paintedFetch = (async () => new Response(paintedCanvas.slice())) as typeof fetch
    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl: paintedFetch, maxTiles: 1 })
    await fetchCanvasTiles(ports, {
      season: 0,
      now: seconds(NOW + 6 * 60 * 60),
      fetchImpl: paintedFetch,
      maxTiles: 1,
    })

    const scanAt = millis((NOW + 12 * 60 * 60) * 1_000)
    const opened = await sql.evaluateTemplateAlarm(
      {
        templateId: 'wide-follow-up',
        versionId: 'wide-follow-up-version',
        total: 20,
        correct: 10,
        observedAt: scanAt,
      },
      { kind: 'scan' },
      'alarm-wide',
    )
    expect(opened.scheduleFollowUp).toBe(true)
    const dueAt = millis(scanAt + 10 * 60 * 1_000)
    const probes = await sql.listDueAlarmProbes(dueAt)
    const blank = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    const blankCanvas = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, blank)
    const blankFetch = (async () => new Response(blankCanvas.slice())) as typeof fetch

    await expect(
      fetchAlarmFollowUps(ports, probes, {
        now: seconds(dueAt / 1_000),
        fetchImpl: blankFetch,
        maxTiles: 1,
      }),
    ).resolves.toEqual({ evaluated: 0, failed: 0, pending: 1 })
    await expect(
      fetchAlarmFollowUps(ports, probes, {
        now: seconds(dueAt / 1_000 + 1),
        fetchImpl: blankFetch,
        maxTiles: 1,
      }),
    ).resolves.toEqual({ evaluated: 1, failed: 0, pending: 0 })
    await expect(sql.readActiveAlarms(0, true)).resolves.toEqual([
      expect.objectContaining({ kind: 'sustained-griefing', pixelsLost: 20 }),
    ])
  }, 20_000)

  it('spends follow-up capacity on attempted tiles instead of abandoned batches', async () => {
    const { ports, sql } = harness()
    const firstTiles = [
      { x: 30, y: 30 },
      { x: 31, y: 30 },
    ]
    const secondTile = { x: 40, y: 40 }
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const chunkHash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', chunkHash, chunk)
    await sql.insertTemplateVersion({
      ...version('first-probe', firstTiles),
      totalPixels: 2,
      chunks: firstTiles.map((tile) => ({ tileX: tile.x, tileY: tile.y, hash: chunkHash })),
    })
    await sql.insertTemplateVersion({
      ...version('second-probe', [secondTile]),
      bbox: {
        minX: secondTile.x * TILE_SIZE,
        minY: secondTile.y * TILE_SIZE,
        maxX: secondTile.x * TILE_SIZE + 1,
        maxY: secondTile.y * TILE_SIZE + 1,
      },
      chunks: [{ tileX: secondTile.x, tileY: secondTile.y, hash: chunkHash }],
    })

    const observedAt = millis(NOW * 1_000)
    for (const [templateId, tiles] of [
      ['first-probe', firstTiles],
      ['second-probe', [secondTile]],
    ] as const) {
      for (const tile of tiles) {
        await sql.recordTileObservation(
          {
            season: 0,
            tile,
            hash: 'f'.repeat(64),
            observedAt,
            reportedAt: NOW,
            reportedWithToken: TOKEN,
            reportedByUserId: 1,
          },
          [
            {
              templateId,
              versionId: `${templateId}-version`,
              tile,
              correct: 1,
              wrong: 0,
              blank: 0,
              observedAt,
            },
          ],
          false,
          true,
        )
      }
    }

    const dueAt = millis(observedAt + 1)
    const probes = ['first-probe', 'second-probe'].map((templateId) => ({
      templateId,
      versionId: `${templateId}-version`,
      season: 0,
      alarmId: `${templateId}-alarm`,
      pixelsLost: 10,
      dueAt,
    }))
    const canvas = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    canvas[0] = 1
    const canvasBytes = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, canvas)
    const requested: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      return url.includes('/30/30.png')
        ? new Response(null, { status: 502 })
        : new Response(canvasBytes.slice())
    }) as typeof fetch

    await expect(
      fetchAlarmFollowUps(ports, probes, {
        now: seconds(NOW + 1),
        fetchImpl,
        maxTiles: 2,
      }),
    ).resolves.toEqual({ evaluated: 1, failed: 1, pending: 1 })
    expect(requested).toEqual([
      expect.stringContaining('/30/30.png'),
      expect.stringContaining('/40/40.png'),
    ])
    await expect(sql.listAlarmTiles(0)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateId: 'second-probe',
          observedAt: (NOW + 1) * 1_000,
        }),
      ]),
    )
  }, 20_000)

  it('caps due probes per watcher cycle and leaves the rest pending', async () => {
    const clearAlarmProbe = vi.fn(async () => undefined)
    const listManifestTemplates = vi.fn(async () => [])
    const ports = {
      sql: {
        clearAlarmProbe,
        listAlarmTiles: vi.fn(async () => []),
        listManifestTemplates,
      },
    } as unknown as FetcherStores
    const probes = ['one', 'two'].map((templateId) => ({
      templateId,
      versionId: `${templateId}-version`,
      season: 0,
      alarmId: `${templateId}-alarm`,
      pixelsLost: 10,
      dueAt: millis(NOW * 1_000),
    }))

    await expect(fetchAlarmFollowUps(ports, probes, { now: NOW, maxProbes: 1 })).resolves.toEqual({
      evaluated: 0,
      failed: 1,
      pending: 1,
    })
    expect(listManifestTemplates).toHaveBeenCalledTimes(1)
    expect(clearAlarmProbe).toHaveBeenCalledTimes(1)
  })

  it('reclassifies an unchanged canvas tile for a new template version', async () => {
    const { ports, sql } = harness()
    const chunk = await encodeIndexedPng(1, 1, new Uint8Array([1]))
    const hash = await sha256Hex(chunk)
    await ports.blobs.put('chunks', hash, chunk)
    const first = {
      ...version('versioned', [{ x: 5, y: 5 }]),
      bbox: {
        minX: 5 * TILE_SIZE,
        minY: 5 * TILE_SIZE,
        maxX: 5 * TILE_SIZE + 1,
        maxY: 5 * TILE_SIZE + 1,
      },
      chunks: [{ tileX: 5, tileY: 5, hash }],
    }
    await sql.insertTemplateVersion(first)
    const indices = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    indices[0] = 1
    const bytes = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, indices)
    const fetchImpl = (async () => new Response(bytes.slice())) as typeof fetch
    await fetchCanvasTiles(ports, { season: 0, now: NOW, fetchImpl })

    await sql.insertTemplateVersion(
      { ...first, versionId: 'versioned-next', createdAt: millis(NOW * 1_000 + 1) },
      { requireExisting: true },
    )
    await fetchCanvasTiles(ports, { season: 0, now: seconds(NOW + 6 * 60 * 60), fetchImpl })

    await expect(sql.readTemplateStatuses(0, true)).resolves.toEqual([
      expect.objectContaining({ templateId: 'versioned', correct: 1, total: 1 }),
    ])
  }, 20_000)
})
