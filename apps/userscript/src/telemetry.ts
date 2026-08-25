import {
  MAX_TILE_OFFERS,
  PALETTE_SIZE,
  type PaintEvent,
  type StatusResponse,
  seconds,
  sha256Hex,
  type TemplateStatus,
  type TileCoord,
  type TileOffer,
  tileKey,
  uuidV7,
} from '@caelestis/shared'
import { warn } from './debug.js'
import type { ServerTemplate } from './server-cache.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onServerContents,
  onStateChange,
  type ServerContents,
} from './state.js'
import type { TemplateColourProgress, TemplateProgress } from './templates/mismatch.js'
import { type AcceptedPaint, onAcceptedPaint, onFetchedTile } from './tile-transform.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

const OFFER_DELAY_MS = 250
const STATUS_POLL_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const RETRIES = 3
const MAX_RECENT_TILES = 32
const MAX_RECENT_TILE_BYTES = 32 * 1_024 * 1_024
const MAX_RECENT_PAINTS = 64

interface OfferedTile extends TileOffer {
  readonly coord: TileCoord
  readonly bytes: Uint8Array
}

interface ServerCoverage {
  readonly server: ConnectedServer
  readonly tiles: ReadonlySet<string>
}

interface ServerQueue {
  readonly server: ConnectedServer
  readonly entries: Map<string, OfferedTile>
}

interface ServerDedupe {
  readonly server: ConnectedServer
  readonly values: Set<string>
}

interface ServerStatus {
  readonly server: ConnectedServer
  readonly value: TemplateStatus
}

interface ObservedPaint {
  readonly eventId: string
  readonly paint: AcceptedPaint
}

const coverage = new Map<string, ServerCoverage>()
const queued = new Map<string, ServerQueue>()
const offered = new Map<string, ServerDedupe>()
const reportedPaints = new Map<string, ServerDedupe>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const statuses = new Map<string, ServerStatus>()
const statusListeners = new Set<() => void>()
const recentTiles = new Map<string, OfferedTile>()
const recentPaints: ObservedPaint[] = []
let recentTileBytes = 0

const statusKey = (serverUrl: string, templateId: string): string =>
  `${serverUrl}\u0000${templateId}`

const authHeaders = (server: ConnectedServer): Record<string, string> =>
  activeServerToken(server) === null ? {} : { authorization: `Bearer ${activeServerToken(server)}` }

const coverageFor = (server: ConnectedServer): ReadonlySet<string> | null => {
  const known = coverage.get(server.url)
  return known !== undefined && isCurrentServerConnection(known.server) ? known.tiles : null
}

const fetchWithRetry = async (url: string, init: RequestInit): Promise<Response | null> => {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok || (response.status >= 400 && response.status < 500)) return response
    } catch {
      // A report is best-effort. The next attempt carries the same paint event id or tile hash.
    }
  }
  return null
}

const coverageFrom = (contents: ServerContents): ReadonlySet<string> =>
  new Set(contents.templates.flatMap((template) => template.chunks.map((chunk) => chunk.tile)))

const uploadWanted = async (
  server: ConnectedServer,
  identity: NonNullable<ReturnType<typeof accountIdentity>>,
  entries: readonly OfferedTile[],
  wanted: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
  const uploaded = new Set<string>()
  await Promise.all(
    entries
      .filter((entry) => wanted.has(entry.tile))
      .map(async (entry) => {
        const response = await fetchWithRetry(
          `${server.url}/telemetry/tiles/${entry.coord.x}/${entry.coord.y}/${entry.sha256}`,
          {
            method: 'PUT',
            headers: {
              ...authHeaders(server),
              'content-type': 'image/png',
              'x-caelestis-season': String(server.season),
              'x-caelestis-observed-at': String(entry.ts),
              'x-caelestis-wplace-user-id': String(identity.wplaceUserId),
              'x-caelestis-display-name': encodeURIComponent(identity.displayName),
            },
            body: entry.bytes.slice().buffer,
          },
        )
        if (response?.ok) uploaded.add(`${entry.tile}\u0000${entry.sha256}`)
        else if (response !== null)
          warn('install', 'telemetry tile upload was rejected', {
            server: server.url,
            tile: entry.tile,
            status: response.status,
          })
      }),
  )
  return uploaded
}

const flushOffers = async (serverUrl: string): Promise<void> => {
  flushTimers.delete(serverUrl)
  const pending = queued.get(serverUrl)
  queued.delete(serverUrl)
  if (
    pending === undefined ||
    pending.entries.size === 0 ||
    !isCurrentServerConnection(pending.server) ||
    pending.server.season === null
  )
    return
  const server = pending.server
  await loadAccount()
  const identity = accountIdentity()
  if (identity === null) return
  const entries = [...pending.entries.values()].slice(0, MAX_TILE_OFFERS)
  const response = await fetchWithRetry(`${server.url}/telemetry/tiles/offers`, {
    method: 'POST',
    headers: { ...authHeaders(server), 'content-type': 'application/json' },
    body: JSON.stringify({
      ...identity,
      season: server.season,
      offers: entries.map(({ tile, sha256, ts }) => ({ tile, sha256, ts })),
    }),
  })
  if (response === null || !response.ok) {
    if (response !== null)
      warn('install', 'telemetry tile offer was rejected', {
        server: server.url,
        status: response.status,
      })
    return
  }
  const body: unknown = await response.json().catch(() => null)
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { wanted?: unknown }).wanted)
  )
    return
  const wanted = new Set(
    (body as { wanted: unknown[] }).wanted.filter(
      (tile): tile is string => typeof tile === 'string',
    ),
  )
  const uploaded = await uploadWanted(server, identity, entries, wanted)
  await refreshStatus(server)
  const previousDedupe = offered.get(server.url)
  const dedupe =
    previousDedupe !== undefined && isCurrentServerConnection(previousDedupe.server)
      ? previousDedupe
      : { server, values: new Set<string>() }
  for (const entry of entries) {
    const offerKey = `${entry.tile}\u0000${entry.sha256}`
    if (!wanted.has(entry.tile) || uploaded.has(offerKey)) dedupe.values.add(offerKey)
  }
  offered.set(server.url, dedupe)
  if (pending.entries.size > entries.length) {
    const rest = new Map([...pending.entries].slice(entries.length))
    queued.set(serverUrl, { server, entries: rest })
    scheduleFlush(serverUrl)
  }
}

const scheduleFlush = (serverUrl: string): void => {
  if (flushTimers.has(serverUrl)) return
  flushTimers.set(
    serverUrl,
    setTimeout(() => void flushOffers(serverUrl).catch(reportTelemetryError), OFFER_DELAY_MS),
  )
}

const shareObservedTile = (entry: OfferedTile): void => {
  if (!getState().shareTiles) return
  for (const server of getState().servers) {
    if (
      server.status !== 'connected' ||
      server.season === null ||
      !coverageFor(server)?.has(entry.tile)
    )
      continue
    const previousDedupe = offered.get(server.url)
    const dedupe =
      previousDedupe !== undefined && isCurrentServerConnection(previousDedupe.server)
        ? previousDedupe
        : { server, values: new Set<string>() }
    const offerKey = `${entry.tile}\u0000${entry.sha256}`
    if (dedupe.values.has(offerKey)) continue
    const previousQueue = queued.get(server.url)
    const serverQueue =
      previousQueue !== undefined && isCurrentServerConnection(previousQueue.server)
        ? previousQueue
        : { server, entries: new Map<string, OfferedTile>() }
    serverQueue.entries.set(entry.tile, entry)
    queued.set(server.url, serverQueue)
    scheduleFlush(server.url)
  }
}

const rememberTile = (entry: OfferedTile): void => {
  const previous = recentTiles.get(entry.tile)
  if (previous !== undefined) recentTileBytes -= previous.bytes.byteLength
  recentTiles.delete(entry.tile)
  recentTiles.set(entry.tile, entry)
  recentTileBytes += entry.bytes.byteLength
  while (recentTiles.size > MAX_RECENT_TILES || recentTileBytes > MAX_RECENT_TILE_BYTES) {
    const oldest = recentTiles.entries().next()
    if (oldest.done) break
    recentTiles.delete(oldest.value[0])
    recentTileBytes -= oldest.value[1].bytes.byteLength
  }
}

const observeTile = async (
  tile: TileCoord,
  bytes: Uint8Array,
  observedAt: number,
): Promise<void> => {
  if (!getState().shareTiles) return
  const entry: OfferedTile = {
    tile: tileKey(tile),
    coord: tile,
    sha256: await sha256Hex(bytes),
    ts: seconds(observedAt),
    bytes,
  }
  rememberTile(entry)
  shareObservedTile(entry)
}

const reportPaint = async (observation: ObservedPaint): Promise<void> => {
  if (!getState().reportPaints) return
  await loadAccount()
  const identity = accountIdentity()
  if (identity === null) return
  const { eventId, paint } = observation
  const submitted = paint.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
  await Promise.all(
    getState().servers.map(async (server) => {
      const serverCoverage = coverageFor(server)
      if (
        server.status !== 'connected' ||
        server.season !== paint.season ||
        serverCoverage === null
      )
        return
      const tiles = paint.tiles.filter((tile) => serverCoverage.has(tileKey(tile)))
      if (tiles.length === 0) return
      const previousDedupe = reportedPaints.get(server.url)
      const dedupe =
        previousDedupe !== undefined && isCurrentServerConnection(previousDedupe.server)
          ? previousDedupe
          : { server, values: new Set<string>() }
      if (dedupe.values.has(eventId)) return
      dedupe.values.add(eventId)
      reportedPaints.set(server.url, dedupe)
      const scopedSubmitted = tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
      const event: PaintEvent = {
        eventId,
        ...identity,
        season: paint.season,
        ts: seconds(paint.observedAt),
        tiles,
        painted:
          tiles.length === paint.tiles.length
            ? paint.painted
            : paint.painted === submitted
              ? scopedSubmitted
              : null,
      }
      const response = await fetchWithRetry(`${server.url}/telemetry/paints`, {
        method: 'POST',
        headers: { ...authHeaders(server), 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })
      if (response?.ok) return
      dedupe.values.delete(eventId)
      if (response !== null)
        warn('install', 'telemetry paint report was rejected', {
          server: server.url,
          status: response.status,
        })
    }),
  )
}

const observePaint = (paint: AcceptedPaint): void => {
  if (!getState().reportPaints) return
  const observation = { eventId: uuidV7(), paint }
  recentPaints.push(observation)
  if (recentPaints.length > MAX_RECENT_PAINTS) recentPaints.shift()
  void reportPaint(observation).catch(reportTelemetryError)
}

const replayRecent = (server: ConnectedServer): void => {
  if (!isCurrentServerConnection(server)) return
  for (const tile of recentTiles.values()) shareObservedTile(tile)
  for (const paint of recentPaints) void reportPaint(paint).catch(reportTelemetryError)
}

const rememberContents = (server: ConnectedServer, contents: ServerContents): void => {
  if (!isCurrentServerConnection(server)) return
  coverage.set(server.url, { server, tiles: coverageFrom(contents) })
  replayRecent(server)
  void refreshStatus(server).catch(reportTelemetryError)
}

const templateStatusFrom = (value: unknown): TemplateStatus | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<TemplateStatus>
  if (
    typeof candidate.templateId !== 'string' ||
    ![
      candidate.correct,
      candidate.wrong,
      candidate.blank,
      candidate.total,
      candidate.observedAt,
    ].every((number) => Number.isSafeInteger(number) && Number(number) >= 0) ||
    Number(candidate.correct) + Number(candidate.wrong) + Number(candidate.blank) >
      Number(candidate.total)
  )
    return null
  if (candidate.colours !== undefined) {
    if (!Array.isArray(candidate.colours) || candidate.colours.length > PALETTE_SIZE) return null
    const indices = new Set<number>()
    let correct = 0
    let wrong = 0
    let blank = 0
    let total = 0
    for (const raw of candidate.colours) {
      if (typeof raw !== 'object' || raw === null) return null
      const colour = raw as Partial<NonNullable<TemplateStatus['colours']>[number]>
      if (
        ![colour.index, colour.correct, colour.wrong, colour.blank, colour.total].every(
          (number) => Number.isSafeInteger(number) && Number(number) >= 0,
        ) ||
        Number(colour.index) >= PALETTE_SIZE - 1 ||
        indices.has(Number(colour.index)) ||
        Number(colour.total) === 0 ||
        Number(colour.correct) + Number(colour.wrong) + Number(colour.blank) > Number(colour.total)
      )
        return null
      indices.add(Number(colour.index))
      correct += Number(colour.correct)
      wrong += Number(colour.wrong)
      blank += Number(colour.blank)
      total += Number(colour.total)
    }
    if (
      correct !== candidate.correct ||
      wrong !== candidate.wrong ||
      blank !== candidate.blank ||
      total !== candidate.total
    )
      return null
  }
  return candidate as TemplateStatus
}

const refreshStatus = async (server: ConnectedServer): Promise<void> => {
  if (server.season === null || !isCurrentServerConnection(server)) return
  const response = await fetchWithRetry(`${server.url}/telemetry/status?season=${server.season}`, {
    headers: authHeaders(server),
  })
  if (response === null || !response.ok || !isCurrentServerConnection(server)) return
  const body = (await response.json().catch(() => null)) as Partial<StatusResponse> | null
  if (body === null || !Array.isArray(body.templates)) return
  let changed = false
  const present = new Set<string>()
  for (const raw of body.templates) {
    const status = templateStatusFrom(raw)
    if (status === null) return
    const key = statusKey(server.url, status.templateId)
    present.add(key)
    if (JSON.stringify(statuses.get(key)?.value) !== JSON.stringify(status)) {
      statuses.set(key, { server, value: status })
      changed = true
    }
  }
  for (const key of [...statuses.keys()]) {
    if (!key.startsWith(`${server.url}\u0000`) || present.has(key)) continue
    statuses.delete(key)
    changed = true
  }
  if (changed) {
    for (const listener of statusListeners) {
      try {
        listener()
      } catch (error) {
        reportTelemetryError(error)
      }
    }
  }
}

export const serverProgressFor = (
  server: ConnectedServer,
  template: Pick<ServerTemplate, 'id' | 'totalPixels'>,
): TemplateProgress | null => {
  const known = statuses.get(statusKey(server.url, template.id))
  const status = known !== undefined && isCurrentServerConnection(known.server) ? known.value : null
  const total = template.totalPixels ?? 0
  if (status === null || status.total !== total) return null
  return {
    completed: status.correct,
    mismatched: status.wrong,
    unpainted: status.blank,
    known: status.correct + status.wrong + status.blank,
    total,
  }
}

export const serverColourProgressFor = (
  server: ConnectedServer,
  template: Pick<ServerTemplate, 'id' | 'totalPixels'>,
): readonly TemplateColourProgress[] | null => {
  const known = statuses.get(statusKey(server.url, template.id))
  const status = known !== undefined && isCurrentServerConnection(known.server) ? known.value : null
  const total = template.totalPixels ?? 0
  if (status === null || status.total !== total || status.colours === undefined) return null
  return status.colours.map((colour) => ({
    index: colour.index,
    completed: colour.correct,
    mismatched: colour.wrong,
    unpainted: colour.blank,
    known: colour.correct + colour.wrong + colour.blank,
    total: colour.total,
  }))
}

export const onServerStatusChange = (listener: () => void): (() => void) => {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

let installed = false

export const installTelemetry = (): void => {
  if (installed) return
  installed = true
  onServerContents(rememberContents)
  onFetchedTile((tile, bytes, observedAt) => {
    void observeTile(tile, bytes, observedAt).catch(reportTelemetryError)
  })
  onAcceptedPaint((paint) => {
    observePaint(paint)
  })
  onStateChange(() => {
    for (const server of getState().servers) {
      if (server.status !== 'connected') continue
      replayRecent(server)
      void refreshStatus(server).catch(reportTelemetryError)
    }
  })
  setInterval(() => {
    for (const server of getState().servers) {
      if (server.status === 'connected') void refreshStatus(server).catch(reportTelemetryError)
    }
  }, STATUS_POLL_MS)
  for (const server of getState().servers) {
    if (server.status === 'connected') void refreshStatus(server).catch(reportTelemetryError)
  }
}

export const reportTelemetryError = (error: unknown): void => {
  warn('install', 'telemetry failed', String(error))
}
