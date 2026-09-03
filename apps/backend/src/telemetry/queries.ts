import {
  type AlarmsResponse,
  type CanvasTilesResponse,
  type ContributionsResponse,
  type HistoryBucket,
  type HistoryResponse,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type Seconds,
  type StatusResponse,
  seconds,
  sha256Hex,
  type TileCoord,
  type TileHistoryFrame,
  type TileHistoryResponse,
  tileKey,
} from '@caelestis/shared'
import { Effect } from 'effect'
import { recordCacheOutcome } from '../metrics/request-metrics.js'
import { LADDER_RESOLUTIONS, TILE_HISTORY_RESOLUTIONS } from '../ports/index.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { SqlStoreReadError } from '../runtime/errors.js'

interface HistoryTier {
  readonly resolution: number
  /** How long this tier is retained. Omitted for the final, permanent tier. */
  readonly retainedFor?: number
  /** Raw tile observations are irregular; one minute is a conservative density estimate. */
  readonly estimatedStep?: number
}

const TELEMETRY_HISTORY_TIERS: readonly HistoryTier[] = [
  { resolution: 60, retainedFor: 6 * 3_600 },
  { resolution: 300, retainedFor: 24 * 3_600 },
  { resolution: 900, retainedFor: 7 * 86_400 },
  { resolution: 3_600, retainedFor: 30 * 86_400 },
  { resolution: 21_600 },
]

const TILE_HISTORY_TIERS: readonly HistoryTier[] = [
  { resolution: 0, retainedFor: 86_400, estimatedStep: 60 },
  { resolution: 3_600, retainedFor: 7 * 86_400 },
  { resolution: 21_600, retainedFor: 30 * 86_400 },
  { resolution: 86_400 },
]

const TARGET_HISTORY_POINTS = 200

export interface HistoryRange {
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

/** Pick one tier that covers the whole range without making the client know the ladder. */
const selectHistoryResolution = (
  tiers: readonly HistoryTier[],
  range: HistoryRange,
  now = seconds(Math.floor(Date.now() / 1_000)),
): number => {
  const permanent = tiers.at(-1)
  if (permanent === undefined) throw new Error('history tier ladder must not be empty')
  const eligible = tiers.filter(
    (tier) => tier.retainedFor === undefined || range.fromSeconds >= now - tier.retainedFor,
  )
  const covering = eligible.length === 0 ? [permanent] : eligible
  const width = range.toSeconds - range.fromSeconds
  const selected =
    covering
      .filter((tier) => width / (tier.estimatedStep ?? tier.resolution) >= TARGET_HISTORY_POINTS)
      .at(-1) ?? covering[0]
  if (selected === undefined) throw new Error('history tier ladder must not be empty')
  return selected.resolution
}

export const selectTelemetryHistoryResolution = (range: HistoryRange, now?: Seconds): number =>
  selectHistoryResolution(TELEMETRY_HISTORY_TIERS, range, now)

export const selectTileHistoryResolution = (range: HistoryRange, now?: Seconds): number =>
  selectHistoryResolution(TILE_HISTORY_TIERS, range, now)

const telemetryCoverageStart = (resolution: number, range: HistoryRange, now: Seconds): Seconds => {
  const index = TELEMETRY_HISTORY_TIERS.findIndex((tier) => tier.resolution === resolution)
  const tier = TELEMETRY_HISTORY_TIERS[index]
  const nextTier = TELEMETRY_HISTORY_TIERS[index + 1]
  if (tier?.retainedFor === undefined || nextTier === undefined) return range.fromSeconds

  // Folding waits until a complete target bucket crosses the retention cutoff. The target bucket
  // containing that cutoff is therefore the first interval with guaranteed source-tier coverage.
  const cutoff = now - tier.retainedFor
  const retainedStart = Math.floor(cutoff / nextTier.resolution) * nextTier.resolution
  const requestedStart = Math.max(range.fromSeconds, retainedStart)
  return seconds(Math.ceil(requestedStart / resolution) * resolution)
}

const coalesceTelemetryHistory = (
  buckets: readonly HistoryBucket[],
  resolution: number,
  range: HistoryRange,
): readonly HistoryBucket[] => {
  const groups = new Map<string, HistoryBucket[]>()
  for (const bucket of buckets) {
    const bucketStart = seconds(Math.floor(bucket.bucketStart / resolution) * resolution)
    if (bucketStart < range.fromSeconds || bucketStart >= range.toSeconds) continue
    const key = `${bucket.templateId}\u0000${bucketStart}`
    const held = groups.get(key) ?? []
    held.push(bucket)
    groups.set(key, held)
  }
  return [...groups.entries()]
    .map(([key, candidates]) => {
      const separator = key.indexOf('\u0000')
      const templateId = key.slice(0, separator)
      const bucketStart = seconds(Number(key.slice(separator + 1)))
      const selected: HistoryBucket[] = []
      for (const candidate of [...candidates].sort(
        (left, right) => right.resolution - left.resolution || left.bucketStart - right.bucketStart,
      )) {
        const end = candidate.bucketStart + candidate.resolution
        if (
          selected.some(
            (held) =>
              candidate.bucketStart < held.bucketStart + held.resolution && end > held.bucketStart,
          )
        ) {
          continue
        }
        selected.push(candidate)
      }
      return {
        templateId,
        resolution,
        bucketStart,
        placed: selected.reduce((total, bucket) => total + bucket.placed, 0),
        correct: selected.reduce((total, bucket) => total + bucket.correct, 0),
        repairs: selected.reduce((total, bucket) => total + bucket.repairs, 0),
      }
    })
    .sort((left, right) =>
      left.templateId < right.templateId
        ? -1
        : left.templateId > right.templateId
          ? 1
          : left.bucketStart - right.bucketStart,
    )
}

const coalesceTileHistory = (
  tiers: readonly { readonly resolution: number; readonly frames: readonly TileHistoryFrame[] }[],
  resolution: number,
  range: HistoryRange,
): readonly TileHistoryFrame[] => {
  if (resolution === 0) return tiers[0]?.frames ?? []
  const groups = new Map<
    number,
    { readonly resolution: number; readonly frame: TileHistoryFrame }[]
  >()
  for (const tier of tiers) {
    for (const frame of tier.frames) {
      const bucketStart = Math.floor(frame.bucketStart / resolution) * resolution
      if (bucketStart < range.fromSeconds || bucketStart >= range.toSeconds) continue
      const held = groups.get(bucketStart) ?? []
      held.push({ resolution: tier.resolution, frame })
      groups.set(bucketStart, held)
    }
  }
  return [...groups]
    .sort(([left], [right]) => left - right)
    .flatMap(([bucketStart, candidates]) => {
      const latest = [...candidates]
        .sort(
          (left, right) =>
            left.frame.bucketStart - right.frame.bucketStart || right.resolution - left.resolution,
        )
        .at(-1)?.frame
      return latest === undefined
        ? []
        : [{ bucketStart: seconds(bucketStart), hash: latest.hash, reporters: latest.reporters }]
    })
}

const sqlRead = <A>(operation: string, read: () => Promise<A>) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => new SqlStoreReadError({ operation, cause }),
  })

export const readAlarms = (
  season: number,
  includeUnpublished: boolean,
): Effect.Effect<AlarmsResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const alarms = yield* sqlRead('readActiveAlarms', () =>
      sql.readActiveAlarms(season, includeUnpublished),
    )
    const version = yield* Effect.promise(() =>
      sha256Hex(new TextEncoder().encode(JSON.stringify(alarms))),
    )
    return { version, alarms }
  })

export const readStatus = (
  season: number,
  includeUnpublished: boolean,
  cacheable: boolean,
): Effect.Effect<StatusResponse, SqlStoreReadError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    if (!cacheable) {
      const sql = yield* SqlStoreService
      const templates = yield* sqlRead('readTemplateStatuses', () =>
        sql.readTemplateStatuses(season, includeUnpublished),
      )
      return { templates }
    }
    const readModel = yield* StatusReadModelService
    const read = yield* sqlRead('reconcileStatusSnapshot', () =>
      readModel.reconcileSnapshot(season, includeUnpublished ? 'admin' : 'public'),
    )
    recordCacheOutcome(read.cacheOutcome)
    return read.snapshot
  })

export const readHistory = (input: {
  readonly templateIds: readonly string[]
  readonly range: HistoryRange
  readonly legacyResolution?: number | undefined
  readonly maxResolution?: number | undefined
  readonly includeUnpublished: boolean
}): Effect.Effect<HistoryResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const maxResolution = input.maxResolution
    const selectableTiers =
      maxResolution === undefined
        ? TELEMETRY_HISTORY_TIERS
        : TELEMETRY_HISTORY_TIERS.filter((tier) => tier.resolution <= maxResolution)
    const readAt = seconds(Math.floor(Date.now() / 1_000))
    const resolution =
      input.legacyResolution ?? selectHistoryResolution(selectableTiers, input.range, readAt)
    // Bucket rows carry no publication state. Resolve ids through the same visibility gate as the
    // manifest so a stale unpublished id looks absent instead of leaking that it still exists.
    const visibleIds = input.includeUnpublished
      ? input.templateIds
      : yield* sqlRead('filterPublishedTemplateIds', () =>
          sql.filterPublishedTemplateIds(input.templateIds),
        )
    const buckets =
      visibleIds.length === 0
        ? []
        : yield* sqlRead('readBuckets', () =>
            sql.readBuckets({
              templateIds: visibleIds,
              resolution:
                input.legacyResolution === undefined
                  ? LADDER_RESOLUTIONS.filter((tier) => tier <= resolution)
                  : resolution,
              ...input.range,
            }),
          )
    return {
      ...(input.maxResolution === undefined
        ? {}
        : {
            resolution,
            coverageStart: telemetryCoverageStart(resolution, input.range, readAt),
          }),
      buckets:
        input.legacyResolution === undefined
          ? coalesceTelemetryHistory(buckets, resolution, input.range)
          : buckets,
    }
  })

export const readContributions = (input: {
  readonly templateIds: readonly string[]
  readonly range: HistoryRange
  readonly includeUnpublished: boolean
}): Effect.Effect<ContributionsResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    // The store already reduces reporter rows per painter-day. Returning those rows directly avoids
    // crediting one day once per reporting client.
    const days = yield* sqlRead('readContributions', () =>
      sql.readContributions({
        templateIds: input.templateIds,
        ...input.range,
        includeUnpublished: input.includeUnpublished,
      }),
    )
    return { days }
  })

export const readLeaderboard = (input: {
  readonly season: number
  readonly templateIds?: readonly string[] | undefined
  readonly from?: Seconds | undefined
  readonly to?: Seconds | undefined
  readonly limit: number
  readonly includeUnpublished: boolean
}): Effect.Effect<LeaderboardResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    // MAX-then-SUM: the store reduced each painter-day across reporters before this route sums days.
    const rows = yield* sqlRead('readContributions', () =>
      sql.readContributions({
        season: input.season,
        ...(input.templateIds === undefined ? {} : { templateIds: input.templateIds }),
        ...(input.from === undefined ? {} : { fromSeconds: input.from }),
        ...(input.to === undefined ? {} : { toSeconds: input.to }),
        includeUnpublished: input.includeUnpublished,
      }),
    )
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
    return {
      entries: [...byUser.values()]
        .map(({ days, ...entry }) => ({ ...entry, activeDays: days.size }))
        .sort(
          (left, right) =>
            right.correct - left.correct ||
            right.placed - left.placed ||
            // The id is only a stable tiebreak. It is not part of the advertised ranking.
            left.wplaceUserId - right.wplaceUserId,
        )
        .slice(0, input.limit),
    }
  })

export const readCanvas = (
  season: number,
): Effect.Effect<CanvasTilesResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const held = yield* sqlRead('listLatestTiles', () => sql.listLatestTiles(season))
    return {
      tiles: held.map((tile) => ({
        tile: tileKey(tile.tile),
        hash: tile.hash,
        observedAt: tile.observedAt,
      })),
    }
  })

export const readTileHistory = (input: {
  readonly season: number
  readonly tile: TileCoord
  readonly range: HistoryRange
  readonly legacyResolution?: number | undefined
}): Effect.Effect<TileHistoryResponse, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const resolution = input.legacyResolution ?? selectTileHistoryResolution(input.range)
    const resolutions =
      input.legacyResolution === undefined
        ? TILE_HISTORY_RESOLUTIONS.filter((tier) => tier <= resolution)
        : [resolution]
    const tiers = yield* sqlRead('readTileHistory', () =>
      Promise.all(
        resolutions.map(async (tier) => ({
          resolution: tier,
          frames: await sql.readTileHistory({
            season: input.season,
            tile: input.tile,
            resolution: tier,
            ...input.range,
          }),
        })),
      ),
    )
    return {
      frames:
        input.legacyResolution === undefined
          ? coalesceTileHistory(tiers, resolution, input.range)
          : (tiers[0]?.frames ?? []),
    }
  })
