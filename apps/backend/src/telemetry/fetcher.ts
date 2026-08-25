import {
  type Seconds,
  seconds,
  sha256Hex,
  type TileCoord,
  tileKey,
  WORLD_TILES,
} from '@caelestis/shared'
import type { Ports } from '../ports/index.js'
import { MAX_CANVAS_TILE_BYTES, recordObservation } from './ingest.js'

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

/** Ring tiles skip their refetch while younger than this — surroundings age fine. */
export const RING_STALENESS_SECONDS = 72_000 // 20 hours: roughly daily under a 6-hour cron.

export interface FetchReport {
  readonly fetched: number
  readonly unchanged: number
  readonly fresh: number
  readonly failed: number
  /** Tiles left for the next run after the per-run budget was spent. */
  readonly deferred: number
}

const wplaceTileUrl = (season: number, tile: TileCoord): string =>
  `https://backend.wplace.live/files/s${season}/tiles/${tile.x}/${tile.y}.png`

export const fetchCanvasTiles = async (
  ports: Ports,
  options: {
    readonly season: number
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
  },
): Promise<FetchReport> => {
  const now = options.now ?? seconds(Math.floor(Date.now() / 1_000))
  const fetchImpl = options.fetchImpl ?? fetch
  const { season } = options

  // Unpublished templates' tiles are fetched too: the storage side is not the read side, and an
  // admin's draft deserves the same timelapse the published version will show.
  const manifestTiles = await ports.sql.listManifestTiles(season, true)
  const templateTiles = new Map<string, TileCoord>()
  for (const row of manifestTiles) {
    const tile = { x: row.tileX, y: row.tileY }
    templateTiles.set(tileKey(tile), tile)
  }
  const ringTiles = new Map<string, TileCoord>()
  for (const tile of templateTiles.values()) {
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
    ...[...templateTiles.values()].map((tile) => ({ tile, ring: false })),
    ...[...ringTiles.values()].map((tile) => ({ tile, ring: true })),
  ]

  let fetched = 0
  let unchanged = 0
  let fresh = 0
  let failed = 0
  const budgeted = work.slice(0, MAX_FETCH_TILES_PER_RUN)
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
      const response = await fetchImpl(wplaceTileUrl(season, tile))
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
        continue
      }
      await ports.blobs.put('tiles', hash, bytes)
      await recordObservation(
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
      )
      fetched++
    } catch {
      // One unreachable tile must not starve the rest of the run.
      failed++
    }
  }

  return { fetched, unchanged, fresh, failed, deferred: work.length - budgeted.length }
}
