import {
  type Alarm,
  type AlarmsResponse,
  MAX_TILE_OFFERS,
  PALETTE_SIZE,
  type PaintEvent,
  type ReconciliationReason,
  type StatusDelta,
  type StatusResponse,
  seconds,
  sha256Hex,
  type TemplateStatus,
  type TileCoord,
  type TileOffer,
  tileKey,
  uuidV7,
} from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { count, warn } from './debug.js'
import type { ServerTemplate } from './server-cache.js'
import { MAX_MANIFEST_TEMPLATES } from './server-manifest.js'
import { invalidateServerMismatchTile } from './server-mismatch.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import {
  applyServerSyncDelta,
  applyServerSyncSnapshot,
  registerServerSyncResource,
  requestServerSync,
  type ServerSyncResult,
  serverSyncRevision,
} from './server-sync-coordinator.js'
import { serverEndpoint } from './server-url.js'
import {
  activeServerToken,
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  onServerContents,
  onStateChange,
  type ServerContents,
  serverConnectionIdentity,
  serverConnectionSignal,
} from './state.js'
import type { TemplateColourProgress, TemplateProgress } from './templates/mismatch.js'
import { TileOfferAcknowledgements } from './tile-offer-acknowledgements.js'
import { type AcceptedPaint, onAcceptedPaint, onFetchedTile } from './tile-transform.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

const OFFER_DELAY_MS = 250
const REQUEST_TIMEOUT_MS = 15_000
const RETRIES = 3
const MAX_RECENT_TILES = 32
const MAX_RECENT_TILE_BYTES = 32 * 1_024 * 1_024
const MAX_RECENT_PAINTS = 64
const MAX_DEDUPE_VALUES = 4_096
const TILE_OFFER_ACKNOWLEDGEMENT_TTL_MS = 5 * 60_000
const MAX_TILE_OFFER_SERVERS = 32
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface OfferedTile extends TileOffer {
  readonly coord: TileCoord
  readonly bytes: Uint8Array
}

interface ServerCoverage {
  readonly server: ConnectedServer
  readonly tiles: ReadonlySet<string>
  readonly contents: ServerContents
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
const reportedPaints = new Map<string, ServerDedupe>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const statuses = new Map<string, ServerStatus>()
const alarms = new Map<
  string,
  {
    readonly server: ConnectedServer
    readonly contents: ServerContents
    readonly value: Alarm
  }
>()
const statusListeners = new Set<() => void>()
const alarmListeners = new Set<() => void>()
const recentTiles = new Map<string, OfferedTile>()
const recentPaints: ObservedPaint[] = []
let recentTileBytes = 0
const tileOfferAcknowledgements = new TileOfferAcknowledgements({
  ttlMs: TILE_OFFER_ACKNOWLEDGEMENT_TTL_MS,
  maxServers: MAX_TILE_OFFER_SERVERS,
  maxReceiptsPerServer: MAX_DEDUPE_VALUES,
})

const tileOfferMetric = (
  outcome: 'avoided' | 'retried' | 'requested' | 'accepted' | 'rejected',
  by = 1,
): void => count(`telemetry:tile-offers-${outcome}`, by)

const offerKey = (entry: TileOffer): string => `${entry.tile}\u0000${entry.sha256}`

/** Remember bounded recent delivery IDs; old values may safely be offered again after eviction. */
const rememberDedupe = (values: Set<string>, value: string): void => {
  if (values.has(value)) return
  while (values.size >= MAX_DEDUPE_VALUES) {
    const oldest = values.values().next()
    if (oldest.done) break
    values.delete(oldest.value)
  }
  values.add(value)
}

const statusKey = (serverUrl: string, templateId: string): string =>
  `${serverUrl}\u0000${templateId}`

const authHeaders = (server: ConnectedServer): Record<string, string> =>
  activeServerToken(server) === null
    ? userscriptClientHeaders()
    : {
        ...userscriptClientHeaders(),
        authorization: `Bearer ${activeServerToken(server)}`,
      }

const coverageFor = (server: ConnectedServer): ReadonlySet<string> | null => {
  const known = coverage.get(server.url)
  return known !== undefined && isCurrentServerConnection(known.server) ? known.tiles : null
}

const wantsObservedTile = (tile: TileCoord): boolean => {
  if (!getState().shareTiles) return false
  const connected = getState().servers.filter(
    (server) => server.status === 'connected' && server.season !== null,
  )
  if (connected.length === 0) return false
  const key = tileKey(tile)
  let awaitingCoverage = false
  for (const server of connected) {
    const known = coverageFor(server)
    if (known === null) awaitingCoverage = true
    else if (known.has(key)) return true
  }
  return awaitingCoverage
}

const fetchWithRetry = async (url: string, init: RequestInit): Promise<Response | null> => {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal:
          init.signal == null
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
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
): Promise<{ readonly uploaded: ReadonlySet<string>; readonly missingStatus: boolean }> => {
  const uploaded = new Set<string>()
  const deltas: StatusDelta[] = []
  let missingStatus = false
  await Promise.all(
    entries
      .filter((entry) => wanted.has(entry.tile))
      .map(async (entry) => {
        const response = await fetchWithRetry(
          serverEndpoint(
            server.url,
            `/telemetry/tiles/${entry.coord.x}/${entry.coord.y}/${entry.sha256}`,
          ),
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
        if (response?.ok) {
          uploaded.add(`${entry.tile}\u0000${entry.sha256}`)
          invalidateServerMismatchTile(server.url, entry.coord)
          const body = (await response.json().catch(() => null)) as { status?: unknown } | null
          const delta = statusDeltaFrom(body?.status)
          if (delta === null) missingStatus = true
          else deltas.push(delta)
        } else if (response !== null)
          warn('install', 'telemetry tile upload was rejected', {
            server: server.url,
            tile: entry.tile,
            status: response.status,
          })
      }),
  )
  deltas.sort(
    (left, right) => left.baseRevision - right.baseRevision || left.revision - right.revision,
  )
  for (const delta of deltas) applyStatusDelta(server, delta)
  return { uploaded, missingStatus }
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
  const season = server.season
  if (season === null) return
  await loadAccount()
  const identity = accountIdentity()
  if (identity === null) return
  const entries = [...pending.entries.values()].slice(0, MAX_TILE_OFFERS)
  const owner = serverConnectionIdentity(server)
  for (const entry of entries)
    tileOfferAcknowledgements.started(server.url, owner, season, offerKey(entry))
  tileOfferMetric('requested', entries.length)
  const response = await fetchWithRetry(serverEndpoint(server.url, '/telemetry/tiles/offers'), {
    method: 'POST',
    headers: { ...authHeaders(server), 'content-type': 'application/json' },
    body: JSON.stringify({
      ...identity,
      season,
      offers: entries.map(({ tile, sha256, ts }) => ({ tile, sha256, ts })),
    }),
  })
  if (response === null || !response.ok) {
    for (const entry of entries)
      tileOfferAcknowledgements.retryable(server.url, owner, season, offerKey(entry))
    if (response !== null && response.status >= 400 && response.status < 500)
      tileOfferMetric('rejected', entries.length)
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
  ) {
    for (const entry of entries)
      tileOfferAcknowledgements.retryable(server.url, owner, season, offerKey(entry))
    return
  }
  const responseBody = body as {
    wanted: unknown[]
    acknowledged?: unknown
    rejected?: unknown
    status?: unknown
  }
  const offeredTiles = new Set<string>(entries.map((entry) => entry.tile))
  const wanted = new Set(
    responseBody.wanted.filter(
      (tile): tile is string => typeof tile === 'string' && offeredTiles.has(tile),
    ),
  )
  const acknowledged = Array.isArray(responseBody.acknowledged)
    ? new Set(
        responseBody.acknowledged.filter(
          (tile): tile is string => typeof tile === 'string' && offeredTiles.has(tile),
        ),
      )
    : null
  const rejected = Array.isArray(responseBody.rejected)
    ? new Set(
        responseBody.rejected.filter(
          (tile): tile is string => typeof tile === 'string' && offeredTiles.has(tile),
        ),
      )
    : null
  const completeDisposition =
    acknowledged !== null &&
    rejected !== null &&
    entries.every(
      (entry) =>
        Number(wanted.has(entry.tile)) +
          Number(acknowledged.has(entry.tile)) +
          Number(rejected.has(entry.tile)) ===
        1,
    )
  const offeredStatus = statusDeltaFrom(responseBody.status)
  if (offeredStatus !== null) applyStatusDelta(server, offeredStatus)
  const { uploaded, missingStatus } = await uploadWanted(server, identity, entries, wanted)
  if (offeredStatus === null || missingStatus)
    requestServerSync('post-offer', 'telemetry-status', server)
  let accepted = 0
  for (const entry of entries) {
    const key = offerKey(entry)
    if ((completeDisposition && acknowledged.has(entry.tile)) || uploaded.has(key)) {
      tileOfferAcknowledgements.acknowledged(server.url, owner, season, key)
      accepted++
    } else if (completeDisposition && rejected.has(entry.tile)) {
      // A refusal is still a definitive acknowledgement. Re-offering it on every canvas read would
      // turn stale client coverage into a hot loop; TTL/reconnect/content changes retain recovery.
      tileOfferAcknowledgements.acknowledged(server.url, owner, season, key)
    } else {
      tileOfferAcknowledgements.retryable(server.url, owner, season, key)
    }
  }
  tileOfferMetric('accepted', accepted)
  if (completeDisposition) tileOfferMetric('rejected', rejected.size)
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
    const decision = tileOfferAcknowledgements.decision(
      server.url,
      serverConnectionIdentity(server),
      server.season,
      offerKey(entry),
    )
    if (decision === 'avoid') {
      tileOfferMetric('avoided')
      continue
    }
    if (decision === 'pending') continue
    if (decision === 'retry') tileOfferMetric('retried')
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
      rememberDedupe(dedupe.values, eventId)
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
      const response = await fetchWithRetry(serverEndpoint(server.url, '/telemetry/paints'), {
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
  coverage.set(server.url, { server, tiles: coverageFrom(contents), contents })
  replayRecent(server)
  requestServerSync('manifest-applied', 'telemetry-alarms', server)
}

const alarmFrom = (value: unknown): Alarm | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<Alarm>
  if (
    typeof candidate.id !== 'string' ||
    !UUID_V7.test(candidate.id) ||
    typeof candidate.templateId !== 'string' ||
    !UUID_V7.test(candidate.templateId) ||
    (candidate.kind !== 'regression' && candidate.kind !== 'sustained-griefing') ||
    ![candidate.pixelsLost, candidate.firstSeen, candidate.lastSeen].every(
      (number) => Number.isSafeInteger(number) && Number(number) >= 0,
    ) ||
    Number(candidate.pixelsLost) === 0 ||
    Number(candidate.firstSeen) > Number(candidate.lastSeen)
  )
    return null
  return candidate as Alarm
}

const templateStatusFrom = (value: unknown): TemplateStatus | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<TemplateStatus>
  if (
    typeof candidate.templateId !== 'string' ||
    !UUID_V7.test(candidate.templateId) ||
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

const statusDeltaFrom = (value: unknown): StatusDelta | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<StatusDelta>
  if (
    !Number.isSafeInteger(candidate.baseRevision) ||
    Number(candidate.baseRevision) < 0 ||
    !Number.isSafeInteger(candidate.revision) ||
    Number(candidate.revision) < Number(candidate.baseRevision) ||
    !Array.isArray(candidate.templates) ||
    candidate.templates.length > MAX_MANIFEST_TEMPLATES ||
    !Array.isArray(candidate.removedTemplateIds) ||
    candidate.removedTemplateIds.length > MAX_MANIFEST_TEMPLATES
  )
    return null
  const templates: TemplateStatus[] = []
  const templateIds = new Set<string>()
  for (const raw of candidate.templates) {
    const status = templateStatusFrom(raw)
    if (status === null || templateIds.has(status.templateId)) return null
    templateIds.add(status.templateId)
    templates.push(status)
  }
  const removedTemplateIds = new Set<string>()
  for (const templateId of candidate.removedTemplateIds) {
    if (
      typeof templateId !== 'string' ||
      !UUID_V7.test(templateId) ||
      templateIds.has(templateId) ||
      removedTemplateIds.has(templateId)
    )
      return null
    removedTemplateIds.add(templateId)
  }
  return {
    baseRevision: Number(candidate.baseRevision),
    revision: Number(candidate.revision),
    templates,
    removedTemplateIds: [...removedTemplateIds],
  }
}

const notifyStatusListeners = (): void => {
  for (const listener of statusListeners) {
    try {
      listener()
    } catch (error) {
      reportTelemetryError(error)
    }
  }
}

const applyStatusDelta = (
  server: ConnectedServer,
  delta: StatusDelta,
): ReturnType<typeof applyServerSyncDelta> =>
  applyServerSyncDelta(
    server,
    'world',
    'telemetry-status',
    String(delta.baseRevision),
    String(delta.revision),
    () => {
      let changed = false
      for (const status of delta.templates) {
        const key = statusKey(server.url, status.templateId)
        if (JSON.stringify(statuses.get(key)?.value) === JSON.stringify(status)) continue
        statuses.set(key, { server, value: status })
        changed = true
      }
      for (const templateId of delta.removedTemplateIds) {
        changed = statuses.delete(statusKey(server.url, templateId)) || changed
      }
      if (changed) notifyStatusListeners()
    },
  )

const refreshStatus = async (
  server: ConnectedServer,
  reason: ReconciliationReason,
): Promise<ServerSyncResult> => {
  if (server.season === null || !isCurrentServerConnection(server)) return { status: 'skipped' }
  return coalesceServerRead(
    serverConnectionIdentity(server),
    `${server.season}\u0000world\u0000status`,
    async () => {
      const startedRevision = serverSyncRevision(server, 'world', 'telemetry-status')
      const response = await fetchWithRetry(
        serverEndpoint(server.url, `/telemetry/status?season=${server.season}`),
        {
          headers: {
            ...authHeaders(server),
            ...userscriptClientHeaders({ transport: 'compatibility-poll', reason }),
          },
          signal: serverConnectionSignal(server),
        },
      )
      if (response === null || !response.ok || !isCurrentServerConnection(server))
        return { status: 'failed' }
      const body = (await response.json().catch(() => null)) as Partial<StatusResponse> | null
      if (
        body === null ||
        !Array.isArray(body.templates) ||
        body.templates.length > MAX_MANIFEST_TEMPLATES ||
        (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 0))
      )
        return { status: 'failed' }
      const next: TemplateStatus[] = []
      const present = new Set<string>()
      for (const raw of body.templates) {
        const status = templateStatusFrom(raw)
        if (status === null) return { status: 'failed' }
        const key = statusKey(server.url, status.templateId)
        present.add(key)
        next.push(status)
      }
      const changed =
        next.some(
          (status) =>
            JSON.stringify(statuses.get(statusKey(server.url, status.templateId))?.value) !==
            JSON.stringify(status),
        ) ||
        [...statuses.keys()].some(
          (key) => key.startsWith(`${server.url}\u0000`) && !present.has(key),
        )
      const result: ServerSyncResult = {
        status: changed ? 'changed' : 'unchanged',
        ...(body.revision === undefined ? {} : { revision: String(body.revision) }),
      }
      applyServerSyncSnapshot(server, 'world', 'telemetry-status', startedRevision, result, () => {
        for (const status of next)
          statuses.set(statusKey(server.url, status.templateId), { server, value: status })
        for (const key of [...statuses.keys()]) {
          if (!key.startsWith(`${server.url}\u0000`) || present.has(key)) continue
          statuses.delete(key)
        }
        if (changed) notifyStatusListeners()
      })
      return { status: 'skipped' }
    },
  )
}

const refreshAlarms = async (
  server: ConnectedServer,
  reason: ReconciliationReason,
): Promise<ServerSyncResult> => {
  if (server.season === null || !isCurrentServerConnection(server)) return { status: 'skipped' }
  const snapshot = coverage.get(server.url)
  if (snapshot === undefined || !isCurrentServerConnection(snapshot.server))
    return { status: 'skipped' }
  return coalesceServerRead(
    serverConnectionIdentity(server),
    `${server.season}\u0000world\u0000alarms`,
    async () => {
      const response = await fetchWithRetry(
        serverEndpoint(server.url, `/telemetry/alarms?season=${server.season}`),
        {
          headers: {
            ...authHeaders(server),
            ...userscriptClientHeaders({ transport: 'compatibility-poll', reason }),
          },
          signal: serverConnectionSignal(server),
        },
      )
      if (
        response === null ||
        !response.ok ||
        !isCurrentServerConnection(server) ||
        coverage.get(server.url) !== snapshot
      )
        return { status: 'failed' }
      const body = (await response.json().catch(() => null)) as Partial<AlarmsResponse> | null
      if (
        body === null ||
        !Array.isArray(body.alarms) ||
        body.alarms.length > MAX_MANIFEST_TEMPLATES
      )
        return { status: 'failed' }
      const parsed: Alarm[] = []
      const templateIds = new Set<string>()
      for (const raw of body.alarms) {
        const alarm = alarmFrom(raw)
        if (alarm === null || templateIds.has(alarm.templateId)) return { status: 'failed' }
        templateIds.add(alarm.templateId)
        parsed.push(alarm)
      }
      let changed = false
      const present = new Set<string>()
      for (const alarm of parsed) {
        const key = statusKey(server.url, alarm.templateId)
        present.add(key)
        const held = alarms.get(key)
        if (
          held?.contents !== snapshot.contents ||
          JSON.stringify(held.value) !== JSON.stringify(alarm)
        ) {
          alarms.set(key, { server, contents: snapshot.contents, value: alarm })
          changed = true
        }
      }
      for (const key of [...alarms.keys()]) {
        if (!key.startsWith(`${server.url}\u0000`) || present.has(key)) continue
        alarms.delete(key)
        changed = true
      }
      if (changed) notifyAlarmListeners()
      return { status: changed ? 'changed' : 'unchanged' }
    },
  )
}

const notifyAlarmListeners = (): void => {
  for (const listener of alarmListeners) {
    try {
      listener()
    } catch (error) {
      reportTelemetryError(error)
    }
  }
}

const alarmEnabled = (server: ConnectedServer, template: ServerTemplate): boolean => {
  const hidden = new Set(getState().hiddenScopes)
  if (
    hidden.has(`server:${server.url}`) ||
    hidden.has(`srv:${encodeURIComponent(server.url)}:${template.id}`)
  )
    return false
  const contents = coverage.get(server.url)?.contents
  const parents = new Map(contents?.nodes.map((node) => [node.id, node.parentId]) ?? [])
  let nodeId = template.nodeId
  for (let depth = 0; nodeId !== null && depth <= parents.size; depth++) {
    if (hidden.has(`node:${encodeURIComponent(server.url)}:${nodeId}`)) return false
    nodeId = parents.get(nodeId) ?? null
  }
  return true
}

export const serverAlarmFor = (
  server: ConnectedServer,
  template: Pick<ServerTemplate, 'id' | 'nodeId' | 'published'>,
): Alarm | null => {
  const known = alarms.get(statusKey(server.url, template.id))
  const snapshot = coverage.get(server.url)
  const current = snapshot?.contents.templates.find((candidate) => candidate.id === template.id)
  if (
    known === undefined ||
    !isCurrentServerConnection(known.server) ||
    snapshot === undefined ||
    !isCurrentServerConnection(snapshot.server) ||
    known.contents !== snapshot.contents ||
    current === undefined ||
    !alarmEnabled(server, current)
  )
    return null
  return known.value
}

export const activeServerAlarms = (): readonly {
  server: ConnectedServer
  template: ServerTemplate
  alarm: Alarm
}[] => {
  const active: Array<{ server: ConnectedServer; template: ServerTemplate; alarm: Alarm }> = []
  for (const server of getState().servers) {
    const contents = coverage.get(server.url)?.contents
    if (server.status !== 'connected' || contents === undefined) continue
    for (const template of contents.templates) {
      const alarm = serverAlarmFor(server, template)
      if (alarm !== null) active.push({ server, template, alarm })
    }
  }
  return active
}

export const onServerAlarmChange = (listener: () => void): (() => void) => {
  alarmListeners.add(listener)
  return () => alarmListeners.delete(listener)
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
  }, wantsObservedTile)
  onAcceptedPaint((paint) => {
    observePaint(paint)
  })
  onStateChange(() => {
    notifyAlarmListeners()
    for (const server of getState().servers) {
      if (server.status !== 'connected') continue
      replayRecent(server)
    }
  })
  registerServerSyncResource({
    id: 'telemetry-status',
    live: true,
    scope: (server) => (server.status === 'connected' && server.season !== null ? 'world' : null),
    refresh: refreshStatus,
    applyLiveEvent: (server, event) => {
      const delta = statusDeltaFrom(event)
      if (delta === null) return false
      applyStatusDelta(server, delta)
      return true
    },
  })
  registerServerSyncResource({
    id: 'telemetry-alarms',
    scope: (server) =>
      server.status === 'connected' && server.season !== null && coverageFor(server) !== null
        ? 'world'
        : null,
    refresh: refreshAlarms,
  })
}

export const reportTelemetryError = (error: unknown): void => {
  warn('install', 'telemetry failed', String(error))
}
