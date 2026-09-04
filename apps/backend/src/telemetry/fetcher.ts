import {
  millis,
  planTimelapseTiles,
  type Seconds,
  seconds,
  sha256Hex,
  type TileCoord,
  type TileKey,
  tileKey,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { AlarmProbe, BlobStore, CounterStore, SqlStore } from '../ports/index.js'
import { createBackendRuntime, makeBackendContext } from '../runtime/backend-runtime.js'
import {
  DirectStatusReadModel,
  publishAlarmChange,
  type StatusReadModelPort,
} from '../status-read-model/port.js'
import { createDerivedArtifactWriteBatch } from './derived-classification.js'
import {
  createStatusProjectionBatch,
  MAX_CANVAS_TILE_BYTES,
  refreshAuthoritativeTile,
  uploadTile,
} from './ingest.js'

/**
 * The server's own tile mirror, run from the 6-hour cron.
 *
 * Userscript reports keep template tiles fresh while anyone is painting; this keeps them from
 * going dark when nobody is, and collects enough surroundings to centre each template in a 16:9
 * timelapse. Context tiles are server-owned and never gate on template coverage.
 *
 * Deduplication happens at three layers, which is why overlapping templates cost nothing extra:
 * the complete plan is a set keyed by tile (two templates sharing a tile fetch it once), the blob
 * store is content-addressed (identical bytes from anywhere store once), and a tile whose hash
 * matches the latest accepted observation is skipped without writing history at all.
 */
export const FETCHER_DISPLAY_NAME = 'Caelestis tile fetcher'

/** The fetcher's synthetic reporter account. No paint event ever carries it, so no leaderboard row. */
export const FETCHER_USER_ID = 0

/**
 * Subrequest budget per run: each tile is one upstream fetch plus a handful of storage calls, and
 * Workers cap subrequests per invocation. The oldest planned tiles go first, so work beyond the
 * budget rotates through later runs instead of permanently starving the same context suffix.
 */
export const MAX_FETCH_TILES_PER_RUN = 100
export const MAX_ALARM_PROBES_PER_RUN = 25
export const ALARM_FOLLOW_UP_RETRY_MILLISECONDS = 60_000

/** The three concrete adapters used by server-owned background tile refreshes. */
export interface FetcherStores {
  readonly blobs: BlobStore
  readonly sql: SqlStore
  readonly counters: CounterStore
  readonly statusReadModel?: StatusReadModelPort
}

export const ALARM_SCAN_INTERVAL_SECONDS = 6 * 60 * 60
/** Cron delivery is not exact; keep a small overlap between adjacent bounded batches. */
export const ALARM_SCAN_JITTER_SECONDS = 5 * 60

const WPLACE_TILE_USER_AGENT = 'Caelestis-Tile-Fetcher/1.0'

export interface FetchReport {
  readonly fetched: number
  readonly unchanged: number
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
  ports: FetcherStores,
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
  const maxTiles = Math.max(1, options.maxTiles ?? MAX_FETCH_TILES_PER_RUN)
  const { season } = options
  const statusReadModel = ports.statusReadModel ?? new DirectStatusReadModel(ports.sql)
  const runtime = createBackendRuntime(
    makeBackendContext(ports.blobs, ports.sql, ports.counters, statusReadModel),
  )
  const projectionBatch = createStatusProjectionBatch(statusReadModel)
  const artifactWriteBatch = createDerivedArtifactWriteBatch(ports.blobs)

  // Plan the whole run before making an upstream request. Unpublished templates are included too:
  // an admin's draft deserves the same timelapse the published version will show.
  const templates = await ports.sql.listManifestTemplates(
    { season, surface: WORLD_TEMPLATE_SURFACE },
    true,
  )
  const alarmTiles = await ports.sql.listAlarmTiles(season)
  const templateTiles = new Map<TileKey, { tile: TileCoord; observedAt: number | null }>()
  for (const row of alarmTiles) {
    const tile = { x: row.tileX, y: row.tileY }
    const key = tileKey(tile)
    const held = templateTiles.get(key)
    if (held === undefined || (row.observedAt ?? -1) < (held.observedAt ?? -1)) {
      templateTiles.set(key, { tile, observedAt: row.observedAt })
    }
  }
  const plannedTiles = new Map(
    planTimelapseTiles(templates.map(({ bbox }) => bbox)).map(
      (tile) => [tileKey(tile), tile] as const,
    ),
  )
  for (const [key, { tile }] of templateTiles) plannedTiles.set(key, tile)
  const historyTiles = new Set(
    planTimelapseTiles(templates.filter(({ finished }) => !finished).map(({ bbox }) => bbox)).map(
      tileKey,
    ),
  )
  const latestTiles = new Map(
    (await ports.sql.listLatestTiles(season)).map(
      (latest) => [tileKey(latest.tile), latest] as const,
    ),
  )

  const tokenHash = await sha256Hex(new TextEncoder().encode('caelestis-tile-fetcher'))
  const work = [...plannedTiles].map(([key, tile]) => {
    const template = templateTiles.get(key)
    const latest = latestTiles.get(key) ?? null
    return {
      tile,
      template: template !== undefined,
      recordHistory: historyTiles.has(key),
      latest,
      observedAt: template?.observedAt ?? latest?.observedAt ?? null,
    }
  })
  work.sort(
    (left, right) =>
      (left.observedAt ?? -1) - (right.observedAt ?? -1) ||
      Number(right.template) - Number(left.template) ||
      left.tile.y - right.tile.y ||
      left.tile.x - right.tile.x,
  )

  let fetched = 0
  let unchanged = 0
  let failed = 0
  const budgeted = work.slice(0, maxTiles)
  const attemptedTemplateTiles = new Set<string>(
    budgeted.filter(({ template }) => template).map(({ tile }) => tileKey(tile)),
  )
  const serverRefreshedTemplateTiles = new Set<string>()
  try {
    for (const { tile, template, recordHistory, latest } of budgeted) {
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
          await runtime.run(
            refreshAuthoritativeTile(
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
              { projectionBatch, artifactWriteBatch },
            ),
          )
          if (template) serverRefreshedTemplateTiles.add(tileKey(tile))
          continue
        }
        await runtime.run(
          uploadTile(
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
            {
              requireCoverage: false,
              recordHistory,
              authoritative: true,
              projectionBatch,
              artifactWriteBatch,
            },
          ),
        )
        if (template) serverRefreshedTemplateTiles.add(tileKey(tile))
        fetched++
      } catch {
        // One unreachable tile must not starve the rest of the run.
        failed++
      }
    }
  } finally {
    try {
      await projectionBatch.flush()
    } finally {
      await artifactWriteBatch.flush()
    }
  }

  const refreshedAlarmTiles = await ports.sql.listAlarmTiles(season)
  const requiredTiles = new Map<
    string,
    Array<{ readonly key: string; readonly observedAt: number | null }>
  >()
  for (const row of refreshedAlarmTiles) {
    const requirement = {
      key: tileKey({ x: row.tileX, y: row.tileY }),
      observedAt: row.observedAt,
    }
    const held = requiredTiles.get(row.templateId)
    if (held === undefined) requiredTiles.set(row.templateId, [requirement])
    else held.push(requirement)
  }
  const statuses = await ports.sql.readTemplateStatuses(season, true, { serverOwnedOnly: true })
  const statusesById = new Map(statuses.map((status) => [status.templateId, status]))
  const scanCycleBatches = Math.max(1, Math.ceil(work.length / maxTiles))
  const freshnessCutoff =
    (now - scanCycleBatches * ALARM_SCAN_INTERVAL_SECONDS - ALARM_SCAN_JITTER_SECONDS) * 1_000
  let followUpScheduled = false
  let alarmsEvaluated = false
  for (const template of templates) {
    const required = requiredTiles.get(template.id) ?? []
    const status = statusesById.get(template.id)
    if (
      required.length === 0 ||
      !required.every(
        ({ key, observedAt }) =>
          observedAt !== null &&
          observedAt >= freshnessCutoff &&
          (!attemptedTemplateTiles.has(key) || serverRefreshedTemplateTiles.has(key)),
      ) ||
      status === undefined ||
      status.total !== template.totalPixels ||
      status.correct + status.wrong + status.blank !== status.total
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
    alarmsEvaluated = true
    followUpScheduled ||= result.scheduleFollowUp
  }
  if (alarmsEvaluated) await publishAlarmChange(statusReadModel, season)

  return {
    fetched,
    unchanged,
    failed,
    deferred: work.length - budgeted.length,
    followUpScheduled,
  }
}

/** Refetch only the templates whose six-hour scan opened a regression episode. */
export const fetchAlarmFollowUps = async (
  ports: FetcherStores,
  probes: readonly AlarmProbe[],
  options: {
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
    /** Test seam; production always uses the Worker-safe batch ceiling. */
    readonly maxTiles?: number
    /** Test seam; production caps query-only probes as well as tile fetches. */
    readonly maxProbes?: number
  } = {},
): Promise<AlarmFollowUpReport> => {
  const now = options.now ?? seconds(Math.floor(Date.now() / 1_000))
  const fetchImpl = options.fetchImpl ?? fetch
  const statusReadModel = ports.statusReadModel ?? new DirectStatusReadModel(ports.sql)
  const runtime = createBackendRuntime(
    makeBackendContext(ports.blobs, ports.sql, ports.counters, statusReadModel),
  )
  const projectionBatch = createStatusProjectionBatch(statusReadModel)
  const artifactWriteBatch = createDerivedArtifactWriteBatch(ports.blobs)
  const tokenHash = await sha256Hex(new TextEncoder().encode('caelestis-tile-fetcher'))
  let evaluated = 0
  let failed = 0
  const evaluatedSeasons = new Set<number>()
  const maxProbes = Math.max(1, options.maxProbes ?? MAX_ALARM_PROBES_PER_RUN)
  const selectedProbes = probes.slice(0, maxProbes)
  let pending = probes.length - selectedProbes.length
  let remaining = Math.max(1, options.maxTiles ?? MAX_FETCH_TILES_PER_RUN)

  try {
    for (const probe of selectedProbes) {
      const template = (
        await ports.sql.listManifestTemplates(
          { season: probe.season, surface: WORLD_TEMPLATE_SURFACE },
          true,
        )
      ).find(
        (candidate) => candidate.id === probe.templateId && candidate.versionId === probe.versionId,
      )
      let tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
        (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
      )
      if (template === undefined || tiles.length === 0) {
        await ports.sql.clearAlarmProbe(probe.templateId, probe.alarmId, probe.dueAt)
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

      let complete = true
      for (const { tile } of batch) {
        remaining--
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
            await runtime.run(
              refreshAuthoritativeTile(
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
                { projectionBatch, artifactWriteBatch },
              ),
            )
            continue
          }
          await runtime.run(
            uploadTile(
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
              {
                requireCoverage: false,
                authoritative: true,
                projectionBatch,
                artifactWriteBatch,
              },
            ),
          )
        } catch {
          complete = false
          break
        }
      }

      if (!complete) {
        await ports.sql.deferAlarmProbe(
          probe.templateId,
          probe.alarmId,
          probe.dueAt,
          millis(now * 1_000 + ALARM_FOLLOW_UP_RETRY_MILLISECONDS),
        )
        failed++
        pending++
        continue
      }
      tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
        (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
      )
      const status = (
        await ports.sql.readTemplateStatuses(probe.season, true, { serverOwnedOnly: true })
      ).find((candidate) => candidate.templateId === probe.templateId)
      if (
        status === undefined ||
        status.total !== template.totalPixels ||
        status.correct + status.wrong + status.blank !== status.total ||
        !tiles.every((row) => row.observedAt !== null && row.observedAt >= probe.dueAt)
      ) {
        if (batch.length === 0) {
          await ports.sql.deferAlarmProbe(
            probe.templateId,
            probe.alarmId,
            probe.dueAt,
            millis(now * 1_000 + ALARM_FOLLOW_UP_RETRY_MILLISECONDS),
          )
          failed++
        }
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
        {
          kind: 'follow-up',
          alarmId: probe.alarmId,
          pixelsLost: probe.pixelsLost,
          dueAt: probe.dueAt,
        },
        'unused',
      )
      evaluated++
      evaluatedSeasons.add(probe.season)
    }
  } finally {
    try {
      await projectionBatch.flush()
    } finally {
      await artifactWriteBatch.flush()
    }
  }

  for (const season of evaluatedSeasons) await publishAlarmChange(statusReadModel, season)

  return { evaluated, failed, pending }
}
