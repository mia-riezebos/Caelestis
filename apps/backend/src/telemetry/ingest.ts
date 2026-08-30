import {
  BLANK,
  decodePng,
  decodeWplaceIndexedPng,
  encodeMismatchMask,
  MATCH,
  millis,
  PALETTE_RGB,
  type PaintEvent,
  quantiseToPalette,
  type Seconds,
  seconds,
  sha256Hex,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
  WRONG,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type {
  BlobStore,
  ContributionDelta,
  CounterDelta,
  CounterStore,
  SqlStore,
  StatusReadModel,
  TelemetryTarget,
  TemplateTileStatusRecord,
  TileObservation,
} from '../ports/index.js'
import {
  BlobStoreService,
  CounterStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { TelemetryStorageError, TelemetryValidationError } from '../runtime/errors.js'
import { readTileBlob, reserveTileBlob, reserveTileBlobUpload } from './tile-blobs.js'

export const MAX_CANVAS_TILE_BYTES = 8 * 1024 * 1024

interface Reporter {
  readonly wplaceUserId: number
  readonly displayName: string
  readonly tokenHash: string
}

export interface TileMetadata extends Reporter {
  readonly season: number
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Seconds
  readonly includeUnpublished: boolean
}

interface ChunkRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const chunkRect = (target: TelemetryTarget): ChunkRect | null => {
  const tileLeft = target.tileX * TILE_SIZE
  const tileTop = target.tileY * TILE_SIZE
  const spans =
    target.bbox.minX < target.bbox.maxX
      ? [{ start: target.bbox.minX, end: target.bbox.maxX }]
      : [
          { start: target.bbox.minX, end: WORLD_PIXELS },
          { start: 0, end: target.bbox.maxX },
        ]
  const span = spans.find(
    (candidate) => candidate.start < tileLeft + TILE_SIZE && candidate.end > tileLeft,
  )
  if (span === undefined) return null
  const startX = Math.max(span.start, tileLeft)
  const endX = Math.min(span.end, tileLeft + TILE_SIZE)
  const startY = Math.max(target.bbox.minY, tileTop)
  const endY = Math.min(target.bbox.maxY, tileTop + TILE_SIZE)
  if (startX >= endX || startY >= endY) return null
  return {
    left: startX - tileLeft,
    top: startY - tileTop,
    width: endX - startX,
    height: endY - startY,
  }
}

const decodeCanvas = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const image = await decodePng(bytes)
  if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
    throw new RangeError(
      `canvas tile is ${image.width}x${image.height}, expected ${TILE_SIZE}x${TILE_SIZE}`,
    )
  }
  return quantiseToPalette(image.pixels, PALETTE_RGB).indices
}

interface ClassifiedTarget {
  readonly status: TemplateTileStatusRecord
  readonly mask?: Uint8Array
}

const classifyTarget = async (
  ports: { readonly blobs: BlobStore },
  target: TelemetryTarget,
  canvas: Uint8Array,
  observedAt: number,
  includeMask = false,
): Promise<ClassifiedTarget | null> => {
  const rect = chunkRect(target)
  if (rect === null) return null
  const bytes = await ports.blobs.get('chunks', target.hash)
  if (bytes === null) return null
  const chunk = await decodeWplaceIndexedPng(bytes)
  if (chunk === null || chunk.width !== rect.width || chunk.height !== rect.height) return null

  let correct = 0
  let wrong = 0
  let blank = 0
  const classifications = includeMask ? new Uint8Array(rect.width * rect.height) : null
  const colours = new Map<
    number,
    { index: number; correct: number; wrong: number; blank: number; total: number }
  >()
  for (let y = 0; y < rect.height; y += 1) {
    const chunkRow = y * rect.width
    const canvasRow = (rect.top + y) * TILE_SIZE + rect.left
    for (let x = 0; x < rect.width; x += 1) {
      const wanted = chunk.indices[chunkRow + x] ?? TRANSPARENT_INDEX
      if (wanted === TRANSPARENT_INDEX) continue
      const actual = canvas[canvasRow + x] ?? TRANSPARENT_INDEX
      const colour = colours.get(wanted) ?? {
        index: wanted,
        correct: 0,
        wrong: 0,
        blank: 0,
        total: 0,
      }
      colour.total++
      if (actual === TRANSPARENT_INDEX) {
        blank++
        colour.blank++
        if (classifications !== null) classifications[chunkRow + x] = BLANK
      } else if (actual === wanted) {
        correct++
        colour.correct++
        if (classifications !== null) classifications[chunkRow + x] = MATCH
      } else {
        wrong++
        colour.wrong++
        if (classifications !== null) classifications[chunkRow + x] = WRONG
      }
      colours.set(wanted, colour)
    }
  }
  return {
    status: {
      templateId: target.templateId,
      versionId: target.versionId,
      tile: { x: target.tileX, y: target.tileY },
      correct,
      wrong,
      blank,
      colours: [...colours.values()].sort((left, right) => left.index - right.index),
      observedAt: millis(observedAt),
    },
    ...(classifications === null
      ? {}
      : {
          mask: encodeMismatchMask(rect, classifications),
        }),
  }
}

export type MismatchMaskRead =
  | { readonly kind: 'found'; readonly bytes: Uint8Array }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unobserved' }

export interface MismatchMaskQuery {
  readonly season: number
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly includeUnpublished: boolean
}

/** Read one server-owned classification mask from the latest accepted canvas observation. */
const readMismatchMaskPromise = async (
  ports: { readonly blobs: BlobStore; readonly sql: SqlStore },
  query: MismatchMaskQuery,
): Promise<MismatchMaskRead> => {
  const targets = await ports.sql.listTelemetryTargets(
    query.season,
    query.tile,
    query.includeUnpublished,
  )
  const target = targets.find(
    (candidate) =>
      candidate.templateId === query.templateId && candidate.versionId === query.versionId,
  )
  if (target === undefined) return { kind: 'not-found' }
  const latest = await ports.sql.readLatestTile(query.season, query.tile)
  if (latest === null) return { kind: 'unobserved' }
  const canvasBytes = await readTileBlob(ports, latest.hash)
  if (canvasBytes === null) return { kind: 'unobserved' }
  const canvas = await decodeCanvas(canvasBytes).catch(() => null)
  if (canvas === null) return { kind: 'unobserved' }
  const classified = await classifyTarget(ports, target, canvas, latest.observedAt, true)
  if (classified?.mask === undefined) return { kind: 'unobserved' }
  return { kind: 'found', bytes: classified.mask }
}

/**
 * Persist an accepted tile: the observation row, its raw history entry, and a status per template
 * chunk the tile carries.
 *
 * Records unconditionally, even with zero covering templates. The reporter routes never reach here
 * uncovered — `uploadTile` refuses and `offerTile` answers `ignored` first — but the server's own
 * fetcher deliberately stores a ring of surrounding tiles no template covers, purely as timelapse
 * and viewer context.
 */
const recordObservationPromise = async (
  ports: {
    readonly blobs: BlobStore
    readonly sql: SqlStore
    readonly statusReadModel?: StatusReadModel
  },
  metadata: TileMetadata,
  bytes: Uint8Array,
  reservationId: string,
  options: { readonly recordHistory?: boolean; readonly authoritative?: boolean } = {},
): Promise<void> => {
  const canvas = await decodeCanvas(bytes)
  const targets = await ports.sql.listTelemetryTargets(
    metadata.season,
    metadata.tile,
    metadata.includeUnpublished,
  )
  const observedAtMs = metadata.observedAt * 1_000
  const classified = (
    await Promise.all(targets.map((target) => classifyTarget(ports, target, canvas, observedAtMs)))
  ).filter((result): result is ClassifiedTarget => result !== null)
  const statuses = classified.map((result) => result.status)
  const observation: TileObservation = {
    season: metadata.season,
    tile: metadata.tile,
    hash: metadata.hash,
    observedAt: millis(observedAtMs),
    reportedAt: metadata.observedAt,
    reportedWithToken: metadata.tokenHash,
    reportedByUserId: metadata.wplaceUserId,
  }
  await ports.sql.rememberPainter(metadata.wplaceUserId, metadata.displayName, millis(observedAtMs))
  const recordHistory =
    options.recordHistory ?? (targets.length === 0 || targets.some((target) => !target.finished))
  const committed = await ports.sql.commitTileBlobReservation(
    reservationId,
    millis(Date.now()),
    observation,
    statuses,
    recordHistory,
    options.authoritative ?? false,
  )
  if (!committed) {
    throw new Error(`tile blob reservation expired before ${metadata.hash} could be recorded`)
  }
  await publishCommittedStatuses(ports, metadata.season, statuses)
  await ports.sql.foldTileHistory(
    metadata.season,
    metadata.tile,
    seconds(Math.floor(Date.now() / 1_000)),
  )
}

const publishCommittedStatuses = async (
  ports: { readonly sql: SqlStore; readonly statusReadModel?: StatusReadModel },
  season: number,
  statuses: readonly TemplateTileStatusRecord[],
): Promise<void> => {
  if (statuses.length === 0) return
  try {
    const revision = await ports.sql.advanceStatusProjectionRevision(season)
    await ports.statusReadModel?.applyCommittedChange({ season, revision })
  } catch (error) {
    // D1 already owns the committed status rows. A revision gap repairs immediately; if revision
    // advancement itself was lost, the bounded safety reconciliation detects changed content,
    // claims a fresh revision, and rebuilds without turning the accepted tile into a retry.
    console.error('status projection publication failed after committed tile observation', error)
  }
}

/** Reclassify bytes already held by the current canvas hash without another upload or history fold. */
/** @internal Shared promise implementation for service-backed background jobs. */
export const refreshAuthoritativeTileWithStores = async (
  ports: {
    readonly blobs: BlobStore
    readonly sql: SqlStore
    readonly statusReadModel?: StatusReadModel
  },
  metadata: TileMetadata,
  bytes: Uint8Array,
): Promise<void> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
    throw new RangeError(`tile must be 1..${MAX_CANVAS_TILE_BYTES} bytes`)
  }
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== metadata.hash) throw new RangeError('tile bytes do not match their sha256')
  const canvas = await decodeCanvas(bytes)
  const targets = await ports.sql.listTelemetryTargets(
    metadata.season,
    metadata.tile,
    metadata.includeUnpublished,
  )
  const observedAt = millis(metadata.observedAt * 1_000)
  const statuses = (
    await Promise.all(targets.map((target) => classifyTarget(ports, target, canvas, observedAt)))
  )
    .filter((result): result is ClassifiedTarget => result !== null)
    .map((result) => result.status)
  await ports.sql.recordTileObservation(
    {
      season: metadata.season,
      tile: metadata.tile,
      hash: metadata.hash,
      observedAt,
      reportedAt: metadata.observedAt,
      reportedWithToken: metadata.tokenHash,
      reportedByUserId: metadata.wplaceUserId,
    },
    statuses,
    false,
    true,
  )
  await publishCommittedStatuses(ports, metadata.season, statuses)
}

/** Process an offer immediately when the content-addressed bytes already exist. */
const offerTilePromise = async (
  ports: {
    readonly blobs: BlobStore
    readonly sql: SqlStore
    readonly statusReadModel?: StatusReadModel
  },
  metadata: TileMetadata,
): Promise<'ignored' | 'wanted' | 'recorded'> => {
  const targets = await ports.sql.listTelemetryTargets(
    metadata.season,
    metadata.tile,
    metadata.includeUnpublished,
  )
  if (targets.length === 0) return 'ignored'
  const held = await reserveTileBlob(ports, metadata.hash)
  if (held === null) return 'wanted'
  await recordObservationPromise(ports, metadata, held.bytes, held.reservation.id)
  return 'recorded'
}

/** @internal Shared promise implementation for service-backed background jobs. */
export const uploadTileWithStores = async (
  ports: {
    readonly blobs: BlobStore
    readonly sql: SqlStore
    readonly statusReadModel?: StatusReadModel
  },
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: {
    readonly requireCoverage?: boolean
    readonly recordHistory?: boolean
    readonly authoritative?: boolean
  } = {},
): Promise<void> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
    throw new RangeError(`tile must be 1..${MAX_CANVAS_TILE_BYTES} bytes`)
  }
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== metadata.hash) throw new RangeError('tile bytes do not match their sha256')
  const targets = await ports.sql.listTelemetryTargets(
    metadata.season,
    metadata.tile,
    metadata.includeUnpublished,
  )
  if (options.requireCoverage !== false && targets.length === 0) {
    throw new RangeError('tile is not covered by a visible template')
  }
  const reservation = await reserveTileBlobUpload(ports, actualHash)
  try {
    await ports.blobs.put('tiles', reservation.blobKey, bytes)
    await recordObservationPromise(ports, metadata, bytes, reservation.id, {
      ...(options.recordHistory === undefined ? {} : { recordHistory: options.recordHistory }),
      ...(options.authoritative === undefined ? {} : { authoritative: options.authoritative }),
    })
  } catch (error) {
    await ports.sql.releaseTileBlobReservation(reservation.id)
    throw error
  }
}

const ourPaletteIndex = (wplaceIndex: number): number =>
  wplaceIndex === 0 ? TRANSPARENT_INDEX : wplaceIndex - 1

const dayOf = (timestamp: Seconds): Seconds => seconds(Math.floor(timestamp / 86_400) * 86_400)

/** Classify a fully accepted paint against server-owned template chunks and the latest tile anchor. */
const recordPaintPromise = async (
  ports: { readonly blobs: BlobStore; readonly sql: SqlStore; readonly counters: CounterStore },
  event: PaintEvent,
  reporterTokenHash: string,
  includeUnpublished: boolean,
): Promise<'duplicate' | 'partial' | 'recorded'> => {
  const seenAt = millis(Date.now())
  if (!(await ports.sql.claimPaintEvent(event.eventId, event.wplaceUserId, seenAt)))
    return 'duplicate'
  await ports.sql.rememberPainter(event.wplaceUserId, event.displayName, seenAt)
  const submitted = event.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
  if (event.painted === null || event.painted !== submitted) return 'partial'

  const totals = new Map<string, { placed: number; correct: number; repairs: number }>()
  for (const paintedTile of event.tiles) {
    const tile = { x: paintedTile.x, y: paintedTile.y }
    const targets = await ports.sql.listTelemetryTargets(event.season, tile, includeUnpublished)
    if (targets.length === 0) continue
    const latest = await ports.sql.readLatestTile(event.season, tile)
    const previousBytes = latest === null ? null : await readTileBlob(ports, latest.hash)
    const previous =
      previousBytes === null ? null : await decodeCanvas(previousBytes).catch(() => null)

    for (const target of targets) {
      if (target.finished) continue
      const rect = chunkRect(target)
      if (rect === null) continue
      const chunkBytes = await ports.blobs.get('chunks', target.hash)
      if (chunkBytes === null) continue
      const chunk = await decodeWplaceIndexedPng(chunkBytes)
      if (chunk === null || chunk.width !== rect.width || chunk.height !== rect.height) continue
      const total = totals.get(target.templateId) ?? { placed: 0, correct: 0, repairs: 0 }
      for (let index = 0; index < paintedTile.pixels.x.length; index += 1) {
        const x = paintedTile.pixels.x[index] ?? -1
        const y = paintedTile.pixels.y[index] ?? -1
        if (
          x < rect.left ||
          x >= rect.left + rect.width ||
          y < rect.top ||
          y >= rect.top + rect.height
        )
          continue
        const wanted =
          chunk.indices[(y - rect.top) * rect.width + (x - rect.left)] ?? TRANSPARENT_INDEX
        if (wanted === TRANSPARENT_INDEX) continue
        const painted = ourPaletteIndex(paintedTile.pixels.colors[index] ?? 0)
        total.placed++
        if (painted !== wanted) continue
        total.correct++
        const before = previous?.[y * TILE_SIZE + x] ?? TRANSPARENT_INDEX
        if (before !== TRANSPARENT_INDEX && before !== wanted) total.repairs++
      }
      totals.set(target.templateId, total)
    }
  }

  const counters: CounterDelta[] = []
  const contributions: ContributionDelta[] = []
  for (const [templateId, total] of totals) {
    counters.push({ templateId, occurredAt: event.ts, ...total })
    contributions.push({
      templateId,
      wplaceUserId: event.wplaceUserId,
      day: dayOf(event.ts),
      reportedWithToken: reporterTokenHash,
      reportedByUserId: event.wplaceUserId,
      ...total,
    })
  }
  await ports.counters.record(counters)
  await ports.sql.addContributions(contributions)
  return 'recorded'
}

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TelemetryStorageError({ operation, cause }),
  })

const upload = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RangeError
        ? new TelemetryValidationError({ message: cause.message })
        : new TelemetryStorageError({ operation: 'uploadTile', cause }),
  })

/** Read one server-owned classification mask from the latest accepted canvas observation. */
export const readMismatchMask = (
  query: MismatchMaskQuery,
): Effect.Effect<MismatchMaskRead, TelemetryStorageError, BlobStoreService | SqlStoreService> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    return yield* storage('readMismatchMask', () => readMismatchMaskPromise({ blobs, sql }, query))
  })

/** Reclassify the current authoritative bytes without creating a history row. */
export const refreshAuthoritativeTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
): Effect.Effect<
  void,
  TelemetryStorageError | TelemetryValidationError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* upload(() =>
      refreshAuthoritativeTileWithStores({ blobs, sql, statusReadModel }, metadata, bytes),
    )
  })

/** Decide whether the server needs one offered tile, recording known bytes immediately. */
export const offerTile = (
  metadata: TileMetadata,
): Effect.Effect<
  'ignored' | 'wanted' | 'recorded',
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* storage('offerTile', () =>
      offerTilePromise({ blobs, sql, statusReadModel }, metadata),
    )
  })

export const offerTiles = (
  offers: readonly { readonly key: string; readonly metadata: TileMetadata }[],
): Effect.Effect<
  {
    readonly wanted: readonly string[]
    readonly accepted: number
    readonly alreadyKnown: number
    readonly rejected: number
  },
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const wanted: string[] = []
    let alreadyKnown = 0
    let rejected = 0
    for (const offer of offers) {
      const decision = yield* offerTile(offer.metadata)
      if (decision === 'wanted') wanted.push(offer.key)
      else if (decision === 'recorded') alreadyKnown++
      else rejected++
    }
    return { wanted, accepted: wanted.length, alreadyKnown, rejected }
  })

/** Validate and persist one uploaded tile without leaking storage failures into a 400 response. */
export const uploadTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: {
    readonly requireCoverage?: boolean
    readonly recordHistory?: boolean
    readonly authoritative?: boolean
  } = {},
): Effect.Effect<
  void,
  TelemetryStorageError | TelemetryValidationError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* upload(() =>
      uploadTileWithStores({ blobs, sql, statusReadModel }, metadata, bytes, options),
    )
  })

/** Classify one accepted paint while preserving claim, counter, and contribution ordering. */
export const recordPaint = (
  event: PaintEvent,
  reporterTokenHash: string,
  includeUnpublished: boolean,
): Effect.Effect<
  'duplicate' | 'partial' | 'recorded',
  TelemetryStorageError,
  BlobStoreService | CounterStoreService | SqlStoreService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const counters = yield* CounterStoreService
    const sql = yield* SqlStoreService
    return yield* storage('recordPaint', () =>
      recordPaintPromise({ blobs, counters, sql }, event, reporterTokenHash, includeUnpublished),
    )
  })
