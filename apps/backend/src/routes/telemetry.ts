import {
  MAX_TILE_OFFERS,
  millis,
  type PaintEvent as PaintEventValue,
  parseTileKey,
  type StatusResponse,
  seconds,
  type TileOfferBatch as TileOfferBatchValue,
  WORLD_TILES,
} from '@caelestis/shared'
import { PaintEvent, TileOfferBatch } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import type { Ports } from '../ports/index.js'
import { MAX_CANVAS_TILE_BYTES, offerTile, recordPaint, uploadTile } from '../telemetry/ingest.js'

const SHA256_HEX = /^[0-9a-f]{64}$/
const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/
const MIN_EPOCH_SECONDS = 1_577_836_800
const MAX_EPOCH_SECONDS = 4_102_444_800

const wholeNumber = (value: string | undefined): number | null => {
  if (value === undefined || !WHOLE_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
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
