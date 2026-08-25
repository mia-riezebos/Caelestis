import {
  MAX_TILE_OFFERS,
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
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onServerContents,
  onStateChange,
  type ServerContents,
} from './state.js'
import type { TemplateProgress } from './templates/mismatch.js'
import { type AcceptedPaint, onAcceptedPaint, onFetchedTile } from './tile-transform.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

const OFFER_DELAY_MS = 250
const STATUS_POLL_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const RETRIES = 3

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

const coverage = new Map<string, ServerCoverage>()
const queued = new Map<string, ServerQueue>()
const offered = new Map<string, ServerDedupe>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const statuses = new Map<string, ServerStatus>()
const statusListeners = new Set<() => void>()

const statusKey = (serverUrl: string, templateId: string): string =>
  `${serverUrl}\u0000${templateId}`

const authHeaders = (server: ConnectedServer): Record<string, string> =>
  server.token === null ? {} : { authorization: `Bearer ${server.token}` }

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

const rememberContents = (server: ConnectedServer, contents: ServerContents): void => {
  if (!isCurrentServerConnection(server)) return
  coverage.set(server.url, { server, tiles: coverageFrom(contents) })
  void refreshStatus(server).catch(reportTelemetryError)
}

const uploadWanted = async (
  server: ConnectedServer,
  identity: NonNullable<ReturnType<typeof accountIdentity>>,
  entries: readonly OfferedTile[],
  wanted: ReadonlySet<string>,
): Promise<void> => {
  await Promise.all(
    entries
      .filter((entry) => wanted.has(entry.tile))
      .map((entry) =>
        fetchWithRetry(
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
        ),
      ),
  )
  await refreshStatus(server)
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
  if (response === null || !response.ok) return
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
  await uploadWanted(server, identity, entries, wanted)
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

const shareTile = async (tile: TileCoord, bytes: Uint8Array, observedAt: number): Promise<void> => {
  if (!getState().shareTiles) return
  const key = tileKey(tile)
  const hash = await sha256Hex(bytes)
  for (const server of getState().servers) {
    if (server.status !== 'connected' || server.season === null || !coverageFor(server)?.has(key))
      continue
    const previousDedupe = offered.get(server.url)
    const dedupe =
      previousDedupe !== undefined && isCurrentServerConnection(previousDedupe.server)
        ? previousDedupe
        : { server, values: new Set<string>() }
    const offerKey = `${key}\u0000${hash}`
    if (dedupe.values.has(offerKey)) continue
    dedupe.values.add(offerKey)
    offered.set(server.url, dedupe)
    const previousQueue = queued.get(server.url)
    const serverQueue =
      previousQueue !== undefined && isCurrentServerConnection(previousQueue.server)
        ? previousQueue
        : { server, entries: new Map<string, OfferedTile>() }
    serverQueue.entries.set(key, {
      tile: key,
      coord: tile,
      sha256: hash,
      ts: seconds(observedAt),
      bytes,
    })
    queued.set(server.url, serverQueue)
    scheduleFlush(server.url)
  }
}

const reportPaint = async (paint: AcceptedPaint): Promise<void> => {
  if (!getState().reportPaints) return
  await loadAccount()
  const identity = accountIdentity()
  if (identity === null) return
  const submitted = paint.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
  const eventId = uuidV7()
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
      await fetchWithRetry(`${server.url}/telemetry/paints`, {
        method: 'POST',
        headers: { ...authHeaders(server), 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })
    }),
  )
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
    void shareTile(tile, bytes, observedAt).catch(reportTelemetryError)
  })
  onAcceptedPaint((paint) => {
    void reportPaint(paint).catch(reportTelemetryError)
  })
  onStateChange(() => {
    for (const server of getState().servers) {
      if (server.status === 'connected') void refreshStatus(server).catch(reportTelemetryError)
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
