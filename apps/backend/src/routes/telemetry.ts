import {
  type CanvasTilesResponse,
  type ContributionsResponse,
  type HistoryResponse,
  type LeaderboardEntry,
  type LeaderboardResponse,
  MAX_TILE_OFFERS,
  millis,
  type PaintEvent as PaintEventValue,
  parseTileKey,
  type Seconds,
  type StatusResponse,
  seconds,
  type TileHistoryResponse,
  type TileOfferBatch as TileOfferBatchValue,
  tileKey,
  WORLD_TILES,
} from '@caelestis/shared'
import { PaintEvent, TileOfferBatch } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { Ports } from '../ports/index.js'
import {
  LADDER_RESOLUTIONS,
  MAX_READ_BUCKETS_TEMPLATE_IDS,
  TILE_HISTORY_RESOLUTIONS,
} from '../ports/index.js'
import {
  MAX_CANVAS_TILE_BYTES,
  offerTile,
  readMismatchMask,
  recordPaint,
  uploadTile,
} from '../telemetry/ingest.js'

const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/
const MIN_EPOCH_SECONDS = 1_577_836_800
const MAX_EPOCH_SECONDS = 4_102_444_800

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
  ports: Ports,
  auth: AuthOptions,
  options: { readonly currentSeason: number },
) => {
  const routes = new Hono()

  routes.get('/status', requireScope(auth, 'read'), async (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const response: StatusResponse = {
      templates: await ports.sql.readTemplateStatuses(season, c.get('caller').scope === 'admin'),
    }
    return c.json(response)
  })

  routes.get(
    '/templates/:templateId/versions/:versionId/tiles/:x/:y/mismatches',
    requireScope(auth, 'read'),
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
      const result = await readMismatchMask(ports, {
        season,
        templateId,
        versionId,
        tile: { x, y },
        includeUnpublished: c.get('caller').scope === 'admin',
      })
      if (result.kind === 'not-found') return c.json({ error: 'template tile not found' }, 404)
      if (result.kind === 'unobserved') return c.body(null, 204)
      return c.body(result.bytes.slice().buffer as ArrayBuffer, 200, {
        'content-type': 'application/vnd.caelestis.mismatch-mask',
        'cache-control': 'no-store',
      })
    },
  )

  routes.get('/history', requireScope(auth, 'read'), async (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) {
      return c.json(
        { error: `templateIds must be 1..${MAX_READ_BUCKETS_TEMPLATE_IDS} comma-separated ids` },
        400,
      )
    }
    const resolution = wholeNumber(c.req.query('resolution'))
    if (resolution === null || !LADDER_RESOLUTIONS.includes(resolution)) {
      return c.json({ error: `resolution must be one of ${LADDER_RESOLUTIONS.join(', ')}` }, 400)
    }
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if (range === null) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    // Buckets carry no publish state of their own, so the ids are resolved through the same gate
    // the manifest applies: to a read-scoped caller an unpublished template's history is as absent
    // as the template — a stale id from an earlier manifest poll answers with nothing, not a 403
    // that would confirm the id still names something.
    const visibleIds =
      c.get('caller').scope === 'admin'
        ? templateIds
        : await ports.sql.filterPublishedTemplateIds(templateIds)
    const response: HistoryResponse = {
      buckets:
        visibleIds.length === 0
          ? []
          : await ports.sql.readBuckets({ templateIds: visibleIds, resolution, ...range }),
    }
    return c.json(response)
  })

  routes.get('/contributions', requireScope(auth, 'read'), async (c) => {
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
    // Rows come back already reduced across reporters — see `readContributions` on the port. The
    // route adds nothing on purpose: serving reporter rows here is the double-credit bug.
    const response: ContributionsResponse = {
      days: await ports.sql.readContributions({
        templateIds,
        ...range,
        includeUnpublished: c.get('caller').scope === 'admin',
      }),
    }
    return c.json(response)
  })

  routes.get('/leaderboard', requireScope(auth, 'read'), async (c) => {
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

    // MAX-then-SUM: the port reduced each painter-day across reporters, so summing here credits
    // each day exactly once no matter how many clients reported it.
    const rows = await ports.sql.readContributions({
      season,
      ...(templateIds === undefined ? {} : { templateIds }),
      ...(from === undefined ? {} : { fromSeconds: seconds(from) }),
      ...(to === undefined ? {} : { toSeconds: seconds(to) }),
      includeUnpublished: c.get('caller').scope === 'admin',
    })
    const byUser = new Map<number, LeaderboardEntry & { readonly days: Set<number> }>()
    for (const row of rows) {
      const held = byUser.get(row.wplaceUserId)
      const entry = held ?? {
        wplaceUserId: row.wplaceUserId,
        displayName: row.displayName,
        placed: 0,
        correct: 0,
        repairs: 0,
        activeDays: 0,
        lastDay: row.day,
        days: new Set<number>(),
      }
      entry.days.add(row.day)
      byUser.set(row.wplaceUserId, {
        ...entry,
        placed: entry.placed + row.placed,
        correct: entry.correct + row.correct,
        repairs: entry.repairs + row.repairs,
        lastDay: row.day > entry.lastDay ? row.day : entry.lastDay,
      })
    }
    const response: LeaderboardResponse = {
      entries: [...byUser.values()]
        .map(({ days, ...entry }) => ({ ...entry, activeDays: days.size }))
        // The user id tiebreak is not part of the advertised order; it only keeps two equal
        // painters from swapping places between requests.
        .sort(
          (left, right) =>
            right.correct - left.correct ||
            right.placed - left.placed ||
            left.wplaceUserId - right.wplaceUserId,
        )
        .slice(0, limit),
    }
    return c.json(response)
  })

  routes.get('/canvas', requireScope(auth, 'read'), async (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : wholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const response: CanvasTilesResponse = {
      tiles: (await ports.sql.listLatestTiles(season)).map((held) => ({
        tile: tileKey(held.tile),
        hash: held.hash,
        observedAt: held.observedAt,
      })),
    }
    return c.json(response)
  })

  // GET here, PUT with a trailing `:hash` above — Hono matches on method and path together, so the
  // two never collide, and `history` is not a valid hash so nothing shadows the upload either.
  routes.get('/tiles/:x/:y/history', requireScope(auth, 'read'), async (c) => {
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
    const resolution = wholeNumber(c.req.query('resolution'))
    if (resolution === null || !TILE_HISTORY_RESOLUTIONS.includes(resolution)) {
      return c.json(
        { error: `resolution must be one of ${TILE_HISTORY_RESOLUTIONS.join(', ')}` },
        400,
      )
    }
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if (range === null) {
      return c.json({ error: 'from and to must be Unix seconds with from < to' }, 400)
    }
    const response: TileHistoryResponse = {
      frames: await ports.sql.readTileHistory({ season, tile: { x, y }, resolution, ...range }),
    }
    return c.json(response)
  })

  routes.post('/tiles/offers', requireScope(auth, 'report'), async (c) => {
    const body = decoded(
      TileOfferBatch,
      await c.req.json().catch(() => null),
    ) as TileOfferBatchValue | null
    if (body === null || body.offers.length > MAX_TILE_OFFERS) {
      return c.json({ error: 'invalid tile offer batch' }, 400)
    }
    if (new Set(body.offers.map((offer) => offer.tile)).size !== body.offers.length) {
      return c.json({ error: 'tile offer batch contains duplicates' }, 400)
    }
    const caller = c.get('caller')
    const wanted: string[] = []
    for (const offer of body.offers) {
      const tile = parseTileKey(offer.tile)
      if (tile === null) return c.json({ error: 'invalid tile offer batch' }, 400)
      const result = await offerTile(ports, {
        wplaceUserId: body.wplaceUserId,
        displayName: body.displayName,
        tokenHash: caller.tokenHash,
        season: body.season,
        tile,
        hash: offer.sha256,
        observedAt: offer.ts,
        includeUnpublished: caller.scope === 'admin',
      })
      if (result === 'wanted') wanted.push(offer.tile)
    }
    return c.json({ wanted })
  })

  routes.put('/tiles/:x/:y/:hash', requireScope(auth, 'report'), async (c) => {
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
    try {
      await uploadTile(
        ports,
        {
          wplaceUserId,
          displayName,
          tokenHash: caller.tokenHash,
          season,
          tile: { x, y },
          hash,
          observedAt: seconds(observedAt),
          includeUnpublished: caller.scope === 'admin',
        },
        bytes,
      )
      return c.body(null, 204)
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  routes.post('/paints', requireScope(auth, 'report'), async (c) => {
    const event = decoded(
      PaintEvent,
      await c.req.json().catch(() => null),
    ) as PaintEventValue | null
    if (event === null) return c.json({ error: 'invalid paint event' }, 400)
    const caller = c.get('caller')
    const result = await recordPaint(ports, event, caller.tokenHash, caller.scope === 'admin')
    return result === 'duplicate'
      ? c.json({ accepted: false, duplicate: true })
      : c.json({ accepted: true, partial: result === 'partial', receivedAt: millis(Date.now()) })
  })

  return routes
}
