import {
  MAX_TILE_OFFERS,
  millis,
  type PaintEvent as PaintEventValue,
  parseTileKey,
  type Seconds,
  seconds,
  type TileOfferBatch as TileOfferBatchValue,
  WORLD_TILES,
} from '@caelestis/shared'
import { PaintEvent, TileOfferBatch } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import { recordTileOfferBatch, recordTileOfferBatchRequested } from '../metrics/request-metrics.js'
import {
  LADDER_RESOLUTIONS,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  TILE_HISTORY_RESOLUTIONS,
} from '../ports/index.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import {
  MAX_CANVAS_TILE_BYTES,
  offerTilesWithOutcome,
  readMismatchMask,
  recordPaint,
  uploadTile,
} from '../telemetry/ingest.js'
import {
  readAlarms,
  readCanvas,
  readContributions,
  readHistory,
  readLeaderboard,
  readStatus,
  readTileHistory,
  selectTelemetryHistoryResolution,
  selectTileHistoryResolution,
} from '../telemetry/queries.js'

export { selectTelemetryHistoryResolution, selectTileHistoryResolution }

const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/
const MIN_EPOCH_SECONDS = 1_577_836_800
const MAX_EPOCH_SECONDS = 4_102_444_800
/** Preserve ordinary device-clock skew without allowing a client to outrank scans indefinitely. */
const MAX_TILE_FUTURE_SKEW_SECONDS = 5 * 60

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Larger leaderboards stop being leaderboards; page by narrowing the window instead. */
const MAX_LEADERBOARD_LIMIT = 200
const DEFAULT_LEADERBOARD_LIMIT = 50

const wholeNumber = (value: string | undefined): number | null => {
  if (value === undefined || !WHOLE_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Comma-separated template ids, validated per id and bounded by the port's read cap. */
const parseTemplateIds = (value: string | undefined): string[] | null => {
  if (value === undefined || value.length === 0) return null
  const ids = value.split(',')
  if (ids.length > MAX_READ_BUCKETS_TEMPLATE_IDS) return null
  return ids.every((id) => UUID_V7.test(id)) ? ids : null
}

/**
 * A half-open `[from, to)` range in Unix seconds. `to <= from` is refused rather than answered with
 * an empty array, because it is always a caller bug — a swapped pair, or a window computed from a
 * clock that went backwards — and an empty chart hides it where a 400 names it.
 */
const parseRange = (
  from: string | undefined,
  to: string | undefined,
): { readonly fromSeconds: Seconds; readonly toSeconds: Seconds } | null => {
  const parsedFrom = wholeNumber(from)
  const parsedTo = wholeNumber(to)
  if (parsedFrom === null || parsedTo === null) return null
  if (parsedTo <= parsedFrom || parsedTo > MAX_EPOCH_SECONDS) return null
  return { fromSeconds: seconds(parsedFrom), toSeconds: seconds(parsedTo) }
}

const decoded = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): unknown | null => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    return null
  }
}

const decodedHeader = (value: string | undefined): string | null => {
  if (value === undefined) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (request.body === null) return null
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) {
        await reader.cancel()
        return null
      }
      parts.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return bytes
}

export const createTelemetryRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: { readonly currentSeason: number },
) => {
  const routes = new Hono()

  routes.get('/status', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    return runBackendHttp(
      c,
      runtime,
      readStatus(season, c.get('caller').scope === 'admin'),
      (response) => c.json(response),
    )
  })

  routes.get('/alarms', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    return runBackendHttp(
      c,
      runtime,
      readAlarms(season, c.get('caller').scope === 'admin'),
      (response) => c.json(response),
    )
  })

  routes.get(
    '/templates/:templateId/versions/:versionId/tiles/:x/:y/mismatches',
    requireScopeEffect(runtime, auth, 'read'),
    async (c) => {
      const templateId = c.req.param('templateId')
      const versionId = c.req.param('versionId')
      const x = wholeNumber(c.req.param('x'))
      const y = wholeNumber(c.req.param('y'))
      const season =
        c.req.query('season') === undefined
          ? options.currentSeason
          : wholeNumber(c.req.query('season'))
      if (
        !UUID_V7.test(templateId) ||
        !UUID_V7.test(versionId) ||
        x === null ||
        y === null ||
        x >= WORLD_TILES ||
        y >= WORLD_TILES ||
        season === null
      ) {
        return c.json({ error: 'template, version, tile and season must be valid' }, 400)
      }
      return runBackendHttp(
        c,
        runtime,
        readMismatchMask({
          season,
          templateId,
          versionId,
          tile: { x, y },
          includeUnpublished: c.get('caller').scope === 'admin',
        }),
        (result) => {
          if (result.kind === 'not-found') return c.json({ error: 'template tile not found' }, 404)
          if (result.kind === 'unobserved') return c.body(null, 204)
          return c.body(result.bytes.slice().buffer as ArrayBuffer, 200, {
            'content-type': 'application/vnd.caelestis.mismatch-mask',
            'cache-control': 'no-store',
          })
        },
      )
    },
  )

  routes.get('/history', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) {
      return c.json(
        { error: `templateIds must be 1..${MAX_READ_BUCKETS_TEMPLATE_IDS} comma-separated ids` },
        400,
      )
    }
    const requestedResolution = c.req.query('resolution')
    const legacyResolution =
      requestedResolution === undefined ? undefined : wholeNumber(requestedResolution)
    const requestedMaxResolution = c.req.query('maxResolution')
    const maxResolution =
      requestedMaxResolution === undefined ? undefined : wholeNumber(requestedMaxResolution)
    if (
      requestedResolution !== undefined &&
      (typeof legacyResolution !== 'number' || !LADDER_RESOLUTIONS.includes(legacyResolution))
    ) {
      return c.json({ error: `resolution must be one of ${LADDER_RESOLUTIONS.join(', ')}` }, 400)
    }
    if (
      requestedMaxResolution !== undefined &&
      (typeof maxResolution !== 'number' || maxResolution < (LADDER_RESOLUTIONS[0] ?? 0))
    ) {
      return c.json({ error: `maxResolution must be at least ${LADDER_RESOLUTIONS[0]}` }, 400)
    }
    if (requestedResolution !== undefined && requestedMaxResolution !== undefined) {
      return c.json({ error: 'resolution and maxResolution cannot be combined' }, 400)
    }
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if (range === null) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readHistory({
        templateIds,
        range,
        ...(typeof legacyResolution === 'number' ? { legacyResolution } : {}),
        ...(typeof maxResolution === 'number' ? { maxResolution } : {}),
        includeUnpublished: c.get('caller').scope === 'admin',
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/contributions', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) {
      return c.json(
        { error: `templateIds must be 1..${MAX_READ_BUCKETS_TEMPLATE_IDS} comma-separated ids` },
        400,
      )
    }
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if (range === null) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readContributions({
        templateIds,
        range,
        includeUnpublished: c.get('caller').scope === 'admin',
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/leaderboard', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const rawTemplateIds = c.req.query('templateIds')
    const templateIds = rawTemplateIds === undefined ? undefined : parseTemplateIds(rawTemplateIds)
    if (templateIds === null) {
      return c.json(
        { error: `templateIds must be 1..${MAX_READ_BUCKETS_TEMPLATE_IDS} comma-separated ids` },
        400,
      )
    }
    const rawFrom = c.req.query('from')
    const rawTo = c.req.query('to')
    const from = rawFrom === undefined ? undefined : wholeNumber(rawFrom)
    const to = rawTo === undefined ? undefined : wholeNumber(rawTo)
    if (from === null || to === null || (from !== undefined && to !== undefined && to <= from)) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    const limit =
      c.req.query('limit') === undefined
        ? DEFAULT_LEADERBOARD_LIMIT
        : wholeNumber(c.req.query('limit'))
    if (limit === null || limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
      return c.json({ error: `limit must be 1..${MAX_LEADERBOARD_LIMIT}` }, 400)
    }

    return runBackendHttp(
      c,
      runtime,
      readLeaderboard({
        season,
        ...(templateIds === undefined ? {} : { templateIds }),
        ...(from === undefined ? {} : { from: seconds(from) }),
        ...(to === undefined ? {} : { to: seconds(to) }),
        limit,
        includeUnpublished: c.get('caller').scope === 'admin',
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/canvas', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    return runBackendHttp(c, runtime, readCanvas(season), (response) => c.json(response))
  })

  // GET here, PUT with a trailing `:hash` above — Hono matches on method and path together, so the
  // two never collide, and `history` is not a valid hash so nothing shadows the upload either.
  routes.get('/tiles/:x/:y/history', requireScopeEffect(runtime, auth, 'read'), (c) => {
    const x = wholeNumber(c.req.param('x'))
    const y = wholeNumber(c.req.param('y'))
    if (x === null || y === null || x >= WORLD_TILES || y >= WORLD_TILES) {
      return c.json({ error: 'tile coordinates must be on the canvas' }, 400)
    }
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const requestedResolution = c.req.query('resolution')
    const legacyResolution =
      requestedResolution === undefined ? undefined : wholeNumber(requestedResolution)
    if (
      requestedResolution !== undefined &&
      (typeof legacyResolution !== 'number' || !TILE_HISTORY_RESOLUTIONS.includes(legacyResolution))
    ) {
      return c.json(
        { error: `resolution must be one of ${TILE_HISTORY_RESOLUTIONS.join(', ')}` },
        400,
      )
    }
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if (range === null) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readTileHistory({
        season,
        tile: { x, y },
        range,
        ...(typeof legacyResolution === 'number' ? { legacyResolution } : {}),
      }),
      (response) => c.json(response),
    )
  })

  routes.post('/tiles/offers', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const body = decoded(
      TileOfferBatch,
      await c.req.json().catch(() => null),
    ) as TileOfferBatchValue | null
    if (body === null || body.offers.length > MAX_TILE_OFFERS) {
      return c.json({ error: 'invalid tile offer batch' }, 400)
    }
    recordTileOfferBatchRequested(body.offers.length)
    if (new Set(body.offers.map((offer) => offer.tile)).size !== body.offers.length) {
      return c.json({ error: 'tile offer batch contains duplicates' }, 400)
    }
    const caller = c.get('caller')
    const receivedAt = seconds(Math.floor(Date.now() / 1_000))
    const offers = []
    for (const offer of body.offers) {
      const tile = parseTileKey(offer.tile)
      if (tile === null) return c.json({ error: 'invalid tile offer batch' }, 400)
      offers.push({
        key: offer.tile,
        metadata: {
          wplaceUserId: body.wplaceUserId,
          displayName: body.displayName,
          tokenHash: caller.tokenHash,
          season: body.season,
          tile,
          hash: offer.sha256,
          // Client clocks can be wrong or hostile. A future row otherwise outranks authoritative
          // server scans until that timestamp arrives.
          observedAt: seconds(Math.min(offer.ts, receivedAt + MAX_TILE_FUTURE_SKEW_SECONDS)),
          includeUnpublished: caller.scope === 'admin',
        },
      })
    }
    return runBackendHttp(c, runtime, offerTilesWithOutcome(offers), (result) => {
      recordTileOfferBatch({
        requested: body.offers.length,
        accepted: result.accepted,
        alreadyKnown: result.alreadyKnown,
        rejected: result.rejected,
      })
      return c.json({ wanted: result.wanted })
    })
  })

  routes.put('/tiles/:x/:y/:hash', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const x = wholeNumber(c.req.param('x'))
    const y = wholeNumber(c.req.param('y'))
    const hash = c.req.param('hash')
    const season = wholeNumber(c.req.header('x-caelestis-season'))
    const observedAt = wholeNumber(c.req.header('x-caelestis-observed-at'))
    const wplaceUserId = wholeNumber(c.req.header('x-caelestis-wplace-user-id'))
    const displayName = decodedHeader(c.req.header('x-caelestis-display-name'))
    if (
      x === null ||
      y === null ||
      x >= WORLD_TILES ||
      y >= WORLD_TILES ||
      !SHA256_HEX.test(hash) ||
      season === null ||
      observedAt === null ||
      observedAt < MIN_EPOCH_SECONDS ||
      observedAt > MAX_EPOCH_SECONDS ||
      wplaceUserId === null ||
      displayName === null ||
      displayName.length === 0 ||
      displayName.length > 256
    ) {
      return c.json({ error: 'invalid tile metadata' }, 400)
    }
    const bytes = await readBoundedBody(c.req.raw, MAX_CANVAS_TILE_BYTES)
    if (bytes === null) return c.json({ error: 'invalid tile body' }, 400)
    const caller = c.get('caller')
    const receivedAt = seconds(Math.floor(Date.now() / 1_000))
    return runBackendHttp(
      c,
      runtime,
      uploadTile(
        {
          wplaceUserId,
          displayName,
          tokenHash: caller.tokenHash,
          season,
          tile: { x, y },
          hash,
          observedAt: seconds(Math.min(observedAt, receivedAt + MAX_TILE_FUTURE_SKEW_SECONDS)),
          includeUnpublished: caller.scope === 'admin',
        },
        bytes,
      ),
      () => c.body(null, 204),
    )
  })

  routes.post('/paints', requireScopeEffect(runtime, auth, 'report'), async (c) => {
    const event = decoded(
      PaintEvent,
      await c.req.json().catch(() => null),
    ) as PaintEventValue | null
    if (event === null) return c.json({ error: 'invalid paint event' }, 400)
    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      recordPaint(event, caller.tokenHash, caller.scope === 'admin'),
      (result) =>
        result === 'duplicate'
          ? c.json({ accepted: false, duplicate: true })
          : c.json({
              accepted: true,
              partial: result === 'partial',
              receivedAt: millis(Date.now()),
            }),
    )
  })

  return routes
}
