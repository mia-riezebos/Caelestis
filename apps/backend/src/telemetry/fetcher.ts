import {
  millis,
  type Seconds,
  seconds,
  sha256Hex,
  type TileCoord,
  tileKey,
  WORLD_TEMPLATE_SURFACE,
  uuidV7,
  WORLD_TILES,
} from '@caelestis/shared'
import type { AlarmProbe, Ports } from '../ports/index.js'
import { MAX_CANVAS_TILE_BYTES, uploadTile } from './ingest.js'

/**
 * The server's own tile mirror, run from the 6-hour cron.
 *
 * Userscript reports keep template tiles fresh while anyone is painting; this keeps them from
 * going dark when nobody is, and collects a one-tile ring of surroundings so the frontend viewer
 * has real canvas context rather than template tiles floating on nothing. Ring tiles are context,
 * not telemetry — they are refreshed lazily and never gate on template coverage.
 *
 * Deduplication happens at three layers, which is why overlapping templates cost nothing extra:
 * the work list is a set keyed by tile (two templates sharing a tile fetch it once), the blob
 * store is content-addressed (identical bytes from anywhere store once), and a tile whose hash
 * matches the latest accepted observation is skipped without writing history at all.
 */
export const FETCHER_DISPLAY_NAME = 'Caelestis tile fetcher'

/** The fetcher's synthetic reporter account. No paint event ever carries it, so no leaderboard row. */
export const FETCHER_USER_ID = 0

/**
 * Subrequest budget per run: each tile is one upstream fetch plus a handful of storage calls, and
 * Workers cap subrequests per invocation. Template tiles are taken before any ring tile, so a
 * server with more coverage than budget degrades to "template tiles only", never the reverse.
 */
export const MAX_FETCH_TILES_PER_RUN = 200

/** A complete rolling snapshot may span the current and immediately preceding cron batch. */
export const ALARM_SCAN_FRESHNESS_SECONDS = 6 * 60 * 60

/** Ring tiles skip their refetch while younger than this — surroundings age fine. */
export const RING_STALENESS_SECONDS = 72_000 // 20 hours: roughly daily under a 6-hour cron.

const WPLACE_TILE_USER_AGENT = 'Caelestis-Tile-Fetcher/1.0'

export interface FetchReport {
  readonly fetched: number
  readonly unchanged: number
  readonly fresh: number
  readonly failed: number
  /** Tiles left for the next run after the per-run budget was spent. */
  readonly deferred: number
  /** Whether at least one regression asked the watcher for a ten-minute probe. */
  readonly followUpScheduled: boolean
}

export interface AlarmFollowUpReport {
  readonly evaluated: number
  readonly failed: number
  /** Due probes that still need another bounded batch. */
  readonly pending: number
}

const compareAlarmTileFreshness = (
  left: { readonly tile: TileCoord; readonly observedAt: number | null },
  right: { readonly tile: TileCoord; readonly observedAt: number | null },
): number =>
  (left.observedAt ?? -1) - (right.observedAt ?? -1) ||
  left.tile.y - right.tile.y ||
  left.tile.x - right.tile.x

const wplaceTileUrl = (season: number, tile: TileCoord): string =>
  `https://backend.wplace.live/files/s${season}/tiles/${tile.x}/${tile.y}.png`

export const fetchCanvasTiles = async (
  ports: Ports,
  options: {
    readonly season: number
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
    readonly alarmIdFactory?: () => string
    /** Test seam; production always uses the Worker-safe batch ceiling. */
    readonly maxTiles?: number
  },
): Promise<FetchReport> => {
  const now = options.now ?? seconds(Math.floor(Date.now() / 1_000))
  const fetchImpl = options.fetchImpl ?? fetch
  const alarmIdFactory = options.alarmIdFactory ?? uuidV7
  const maxTiles = options.maxTiles ?? MAX_FETCH_TILES_PER_RUN
  const { season } = options

  // Unpublished templates' tiles are fetched too: the storage side is not the read side, and an
  // admin's draft deserves the same timelapse the published version will show.
  const alarmTiles = await ports.sql.listAlarmTiles(season)
  const templateTiles = new Map<string, { tile: TileCoord; observedAt: number | null }>()
  for (const row of alarmTiles) {
    const tile = { x: row.tileX, y: row.tileY }
    const key = tileKey(tile)
    const held = templateTiles.get(key)
    if (held === undefined || (row.observedAt ?? -1) < (held.observedAt ?? -1)) {
      templateTiles.set(key, { tile, observedAt: row.observedAt })
    }
  }
  const ringTiles = new Map<string, TileCoord>()
  for (const { tile } of templateTiles.values()) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = tile.y + dy
        if (y < 0 || y >= WORLD_TILES) continue
        const neighbour = { x: (tile.x + dx + WORLD_TILES) % WORLD_TILES, y }
        const key = tileKey(neighbour)
        if (!templateTiles.has(key) && !ringTiles.has(key)) ringTiles.set(key, neighbour)
      }
    }
  }

  const tokenHash = await sha256Hex(new TextEncoder().encode('caelestis-tile-fetcher'))
  const work: { tile: TileCoord; ring: boolean }[] = [
    ...[...templateTiles.values()]
      .sort(compareAlarmTileFreshness)
      .map(({ tile }) => ({ tile, ring: false })),
    ...[...ringTiles.values()].map((tile) => ({ tile, ring: true })),
  ]

  let fetched = 0
  let unchanged = 0
  let fresh = 0
  let failed = 0
  const budgeted = work.slice(0, maxTiles)
  for (const { tile, ring } of budgeted) {
    const latest = await ports.sql.readLatestTile(season, tile)
    if (
      ring &&
      latest !== null &&
      now * 1_000 - latest.observedAt < RING_STALENESS_SECONDS * 1_000
    ) {
      fresh++
      continue
    }
    try {
      const response = await fetchImpl(wplaceTileUrl(season, tile), {
        headers: { 'user-agent': WPLACE_TILE_USER_AGENT },
      })
      if (!response.ok) {
        failed++
        continue
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
        failed++
        continue
      }
      const hash = await sha256Hex(bytes)
      if (latest?.hash === hash) {
        unchanged++
        if (!ring) {
          await uploadTile(
            ports,
            {
              wplaceUserId: FETCHER_USER_ID,
              displayName: FETCHER_DISPLAY_NAME,
              tokenHash,
              season,
              tile,
              hash,
              observedAt: now,
              includeUnpublished: true,
            },
            bytes,
            { requireCoverage: false, recordHistory: false },
          )
        }
        continue
      }
      await uploadTile(
        ports,
        {
          wplaceUserId: FETCHER_USER_ID,
          displayName: FETCHER_DISPLAY_NAME,
          tokenHash,
          season,
          tile,
          hash,
          observedAt: now,
          includeUnpublished: true,
        },
        bytes,
        { requireCoverage: false },
      )
      fetched++
    } catch {
      // One unreachable tile must not starve the rest of the run.
      failed++
    }
  }

  const templates = await ports.sql.listManifestTemplates(season, true)
  const refreshedAlarmTiles = await ports.sql.listAlarmTiles(season)
  const requiredTiles = new Map<string, Array<number | null>>()
  for (const row of refreshedAlarmTiles) {
    const held = requiredTiles.get(row.templateId)
    if (held === undefined) requiredTiles.set(row.templateId, [row.observedAt])
    else held.push(row.observedAt)
  }
  const statuses = await ports.sql.readTemplateStatuses(season, true)
  const statusesById = new Map(statuses.map((status) => [status.templateId, status]))
  let followUpScheduled = false
  for (const template of templates) {
    const required = requiredTiles.get(template.id) ?? []
    const status = statusesById.get(template.id)
    if (
      required.length === 0 ||
      !required.every(
        (observedAt) =>
          observedAt !== null && observedAt >= (now - ALARM_SCAN_FRESHNESS_SECONDS) * 1_000,
      ) ||
      status === undefined ||
      status.total !== template.totalPixels
    ) {
      continue
    }
    const result = await ports.sql.evaluateTemplateAlarm(
      {
        templateId: template.id,
        versionId: template.versionId,
        total: status.total,
        correct: status.correct,
        observedAt: millis(now * 1_000),
      },
      { kind: 'scan' },
      alarmIdFactory(),
    )
    followUpScheduled ||= result.scheduleFollowUp
  }

  return {
    fetched,
    unchanged,
    fresh,
    failed,
    deferred: work.length - budgeted.length,
    followUpScheduled,
  }
}

/** Refetch only the templates whose six-hour scan opened a regression episode. */
export const fetchAlarmFollowUps = async (
  ports: Ports,
  probes: readonly AlarmProbe[],
  options: {
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
    /** Test seam; production always uses the Worker-safe batch ceiling. */
    readonly maxTiles?: number
  } = {},
): Promise<AlarmFollowUpReport> => {
  const now = options.now ?? seconds(Math.floor(Date.now() / 1_000))
  const fetchImpl = options.fetchImpl ?? fetch
  const tokenHash = await sha256Hex(new TextEncoder().encode('caelestis-tile-fetcher'))
  let evaluated = 0
  let failed = 0
  let pending = 0
  let remaining = options.maxTiles ?? MAX_FETCH_TILES_PER_RUN

  for (const probe of probes) {
    const template = (await ports.sql.listManifestTemplates(probe.season, true)).find(
      (candidate) => candidate.id === probe.templateId && candidate.versionId === probe.versionId,
    )
    let tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
      (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
    )
    if (template === undefined || tiles.length === 0) {
      await ports.sql.clearAlarmProbe(probe.templateId, probe.alarmId)
      failed++
      continue
    }
    const staleTiles = tiles
      .filter((row) => row.observedAt === null || row.observedAt < probe.dueAt)
      .map((row) => ({
        ...row,
        tile: { x: row.tileX, y: row.tileY },
      }))
      .sort(compareAlarmTileFreshness)
    if (staleTiles.length > 0 && remaining === 0) {
      pending++
      continue
    }
    const batch = staleTiles.slice(0, remaining)
    remaining -= batch.length

    let complete = true
    for (const { tile } of batch) {
      try {
        const response = await fetchImpl(wplaceTileUrl(probe.season, tile), {
          headers: { 'user-agent': WPLACE_TILE_USER_AGENT },
        })
        if (!response.ok) {
          complete = false
          break
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
          complete = false
          break
        }
        const hash = await sha256Hex(bytes)
        const latest = await ports.sql.readLatestTile(probe.season, tile)
        if (latest?.hash === hash) {
          await uploadTile(
            ports,
            {
              wplaceUserId: FETCHER_USER_ID,
              displayName: FETCHER_DISPLAY_NAME,
              tokenHash,
              season: probe.season,
              tile,
              hash,
              observedAt: now,
              includeUnpublished: true,
            },
            bytes,
            { requireCoverage: false, recordHistory: false },
          )
          continue
        }
        await uploadTile(
          ports,
          {
            wplaceUserId: FETCHER_USER_ID,
            displayName: FETCHER_DISPLAY_NAME,
            tokenHash,
            season: probe.season,
            tile,
            hash,
            observedAt: now,
            includeUnpublished: true,
          },
          bytes,
          { requireCoverage: false },
        )
      } catch {
        complete = false
        break
      }
    }

    if (!complete) {
      failed++
      pending++
      continue
    }
    tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
      (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
    )
    const status = (await ports.sql.readTemplateStatuses(probe.season, true)).find(
      (candidate) => candidate.templateId === probe.templateId,
    )
    if (
      status === undefined ||
      status.total !== template.totalPixels ||
      !tiles.every((row) => row.observedAt !== null && row.observedAt >= probe.dueAt)
    ) {
      if (batch.length === 0) failed++
      pending++
      continue
    }
    await ports.sql.evaluateTemplateAlarm(
      {
        templateId: probe.templateId,
        versionId: probe.versionId,
        total: status.total,
        correct: status.correct,
        observedAt: millis(now * 1_000),
      },
      { kind: 'follow-up', alarmId: probe.alarmId, pixelsLost: probe.pixelsLost },
      'unused',
    )
    evaluated++
  }

  return { evaluated, failed, pending }
}
