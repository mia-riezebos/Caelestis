import {
  MAX_TILE_OFFERS,
  SERVER_SYNC_FALLBACK_MIN_MS,
  TILE_OFFER_BATCH_DELAY_MS,
} from '@caelestis/shared'
import { LADDER_RESOLUTIONS, TILE_HISTORY_RESOLUTIONS } from '../ports/index.js'

const DAY_SECONDS = 86_400
const DAYS_PER_MONTH = 30

export const FREE_TIER_LIMITS = {
  workerRequestsPerDay: 100_000,
  durableObjectRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytes: 5_000_000_000,
  r2StorageBytes: 10_000_000_000,
  r2ClassAPerMonth: 1_000_000,
  r2ClassBPerMonth: 10_000_000,
} as const

export const CURRENT_CLIENT_CAPACITY_DEFAULTS = {
  paintBatchWindowSeconds: 0,
  maxPaintEventsPerReport: 1,
  tileOfferBatchWindowSeconds: TILE_OFFER_BATCH_DELAY_MS / 1_000,
  maxTileOffersPerRequest: MAX_TILE_OFFERS,
  statusPollIntervalSeconds: SERVER_SYNC_FALLBACK_MIN_MS / 1_000,
  statusRefreshesPerTileOfferRequest: 1,
  lifecycleStatusRefreshesPerUserDay: 2,
} as const

/** The low end of Cloudflare's 200-500 requests/s guidance for storage-heavy objects. */
export const SINGLE_SHARD_REQUESTS_PER_SECOND_BUDGET = 200

export interface CapacityInputs {
  readonly activeUsers: number
  /** Average time each reporting userscript stays open per day. */
  readonly activeHoursPerUser: number
  readonly templates: number
  readonly coveredTiles: number
  /** Accepted wplace paint requests, not pixels. Current telemetry sends one event per request. */
  readonly paintEventsPerUserHour: number
  readonly tileFetchesPerUserHour: number
  readonly averageTemplatesPerPaint: number
  readonly averageTilesPerPaint: number
  readonly averageTemplatesPerTile: number
  readonly classifiedPaintFraction: number
  readonly paintBatchWindowSeconds: number
  readonly maxPaintEventsPerReport: number
  readonly tileOfferBatchWindowSeconds: number
  readonly maxTileOffersPerRequest: number
  readonly statusPollIntervalSeconds: number
  /** Successful offer batches currently trigger one immediate status refresh. */
  readonly statusRefreshesPerTileOfferRequest: number
  /** Connection and content lifecycle refreshes, separate from adaptive fallback polling. */
  readonly lifecycleStatusRefreshesPerUserDay: number
  /** Distinct content hashes retained per covered tile and day. */
  readonly tileVersionsPerCoveredTileDay: number
  readonly averageTileBytes: number
  /** Age of the deployment whose cumulative storage is being estimated. */
  readonly historyDays: number
  /** Calibrate this from D1 database size divided by retained logical rows. */
  readonly d1BytesPerLogicalRow: number
  /** D1 bills every row scanned by a status query. Calibrate this from D1 Insights. */
  readonly d1RowsReadPerStatusRequest: number
  /** Route-specific D1 reads calibrated from D1 Insights for the observed workload. */
  readonly d1RowsReadPerPaintReportRequest: number
  /**
   * Aggregate offer and upload reads per accepted client tile observation. D1 Insights does not
   * retain HTTP request ids, so this unit preserves the measured baseline across offer batching and
   * partial uploads instead of inventing route request counts.
   */
  readonly d1RowsReadPerTileObservation: number
  /** Manifest, dashboard, and other queries outside the telemetry request model. */
  readonly otherD1RowsReadPerDay: number
  readonly otherWorkerRequestsPerDay: number
  /** Current rows whose lifetime is not already modeled by telemetry retention. */
  readonly persistentD1Rows: number
}

export interface CapacityEstimate {
  readonly traffic: {
    readonly paintEvents: number
    readonly classifiedPaintEvents: number
    readonly paintReportRequests: number
    readonly tileOffers: number
    readonly tileOfferRequests: number
    readonly tileUploadRequests: number
    readonly tileObservations: number
    readonly periodicStatusPollRequests: number
    readonly offerStatusRefreshRequests: number
    readonly lifecycleStatusRefreshRequests: number
    /** All status requests: periodic, post-offer, and lifecycle-triggered. */
    readonly statusRequests: number
  }
  readonly daily: {
    readonly workerRequests: number
    readonly durableObjectRequests: number
    readonly durableObjectAlarmRequests: number
    readonly d1RowsRead: number
    readonly d1LogicalRowMutations: number
    /** Conservative ceiling that counts every applicable table and index mutation. */
    readonly d1RowsWrittenUpperBound: number
    readonly r2ClassAOperations: number
    readonly r2ClassBOperations: number
    readonly r2StorageGrowthBytes: number
  }
  readonly storage: {
    readonly d1LogicalRows: number
    readonly d1Bytes: number
    readonly r2Bytes: number
  }
  readonly batching: {
    /** Null means fixed traffic already exhausts a free limit or the configured batch cap is too low. */
    readonly minimumPaintBatchWindowSecondsForFreeTier: number | null
  }
  readonly sharding: {
    readonly singleShardPeakRequestsPerSecond: number
    readonly perTemplateNeeded: boolean
  }
  readonly utilization: {
    readonly workerRequests: number
    readonly durableObjectRequests: number
    readonly d1RowsRead: number
    readonly d1RowsWritten: number
    readonly d1Storage: number
    readonly r2ClassAOperations: number
    readonly r2ClassBOperations: number
    readonly r2Storage: number
    readonly firstLimit: keyof Omit<CapacityEstimate['utilization'], 'firstLimit'>
  }
}

const assertFiniteNonNegative = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
}

const assertInputs = (inputs: CapacityInputs): void => {
  for (const [name, value] of Object.entries(inputs)) assertFiniteNonNegative(name, value)
  for (const name of ['activeUsers', 'templates', 'coveredTiles'] as const) {
    if (!Number.isSafeInteger(inputs[name])) throw new RangeError(`${name} must be an integer`)
  }
  if (inputs.activeHoursPerUser > 24) throw new RangeError('activeHoursPerUser must be at most 24')
  if (inputs.classifiedPaintFraction > 1) {
    throw new RangeError('classifiedPaintFraction must be at most 1')
  }
  if (inputs.statusPollIntervalSeconds === 0 && inputs.activeUsers > 0) {
    throw new RangeError('statusPollIntervalSeconds must be positive when users are active')
  }
  if (inputs.maxPaintEventsPerReport < 1 || !Number.isSafeInteger(inputs.maxPaintEventsPerReport)) {
    throw new RangeError('maxPaintEventsPerReport must be a positive integer')
  }
  if (inputs.maxTileOffersPerRequest < 1 || !Number.isSafeInteger(inputs.maxTileOffersPerRequest)) {
    throw new RangeError('maxTileOffersPerRequest must be a positive integer')
  }
}

/** Expected fixed-window batches for one Poisson-like client stream, summed across clients. */
const expectedBatches = (
  events: number,
  ratePerUserSecond: number,
  windowSeconds: number,
  maximumBatchSize: number,
): number => {
  if (events === 0) return 0
  const expectedBatchSize = Math.min(maximumBatchSize, 1 + ratePerUserSecond * windowSeconds)
  return events / expectedBatchSize
}

const occupiedBuckets = (
  assignmentsPerDay: number,
  entities: number,
  resolutionSeconds: number,
): number => {
  if (assignmentsPerDay === 0 || entities === 0) return 0
  const slots = entities * (DAY_SECONDS / resolutionSeconds)
  return slots * -Math.expm1(-assignmentsPerDay / slots)
}

const retainedBandDays = (historyDays: number, start: number, end?: number): number =>
  Math.max(0, Math.min(historyDays, end ?? historyDays) - start)

const minimumBatchWindow = (
  events: number,
  eventRatePerUserSecond: number,
  maximumBatchSize: number,
  maximumRequests: number,
): number | null => {
  if (events <= maximumRequests) return 0
  if (maximumRequests <= 0 || eventRatePerUserSecond === 0) return null
  const requiredBatchSize = events / maximumRequests
  if (requiredBatchSize > maximumBatchSize) return null
  return (requiredBatchSize - 1) / eventRatePerUserSecond
}

export const estimateCapacity = (inputs: CapacityInputs): CapacityEstimate => {
  assertInputs(inputs)

  const activeUserHours = inputs.activeUsers * inputs.activeHoursPerUser
  const paintEvents = activeUserHours * inputs.paintEventsPerUserHour
  const classifiedPaintEvents = paintEvents * inputs.classifiedPaintFraction
  const tileOffers = activeUserHours * inputs.tileFetchesPerUserHour
  const paintRatePerUserSecond = inputs.paintEventsPerUserHour / 3_600
  const tileRatePerUserSecond = inputs.tileFetchesPerUserHour / 3_600
  const paintReportRequests = expectedBatches(
    paintEvents,
    paintRatePerUserSecond,
    inputs.paintBatchWindowSeconds,
    inputs.maxPaintEventsPerReport,
  )
  const tileOfferRequests = expectedBatches(
    tileOffers,
    tileRatePerUserSecond,
    inputs.tileOfferBatchWindowSeconds,
    inputs.maxTileOffersPerRequest,
  )
  const newTileVersions = inputs.coveredTiles * inputs.tileVersionsPerCoveredTileDay
  const tileUploadRequests = Math.min(tileOffers, newTileVersions)
  const serverOnlyTileObservations = Math.max(0, newTileVersions - tileUploadRequests)
  const tileObservations = tileOffers + serverOnlyTileObservations
  const periodicStatusPollRequests = activeUserHours * (3_600 / inputs.statusPollIntervalSeconds)
  const offerStatusRefreshRequests = tileOfferRequests * inputs.statusRefreshesPerTileOfferRequest
  const lifecycleStatusRefreshRequests =
    inputs.activeUsers * inputs.lifecycleStatusRefreshesPerUserDay
  const statusRequests =
    periodicStatusPollRequests + offerStatusRefreshRequests + lifecycleStatusRefreshRequests
  const d1RowsRead =
    statusRequests * inputs.d1RowsReadPerStatusRequest +
    paintReportRequests * inputs.d1RowsReadPerPaintReportRequest +
    tileOffers * inputs.d1RowsReadPerTileObservation +
    inputs.otherD1RowsReadPerDay

  const paintTemplateTouches = classifiedPaintEvents * inputs.averageTemplatesPerPaint
  const paintTileTouches = classifiedPaintEvents * inputs.averageTilesPerPaint
  const telemetryBuckets = new Map(
    LADDER_RESOLUTIONS.map((resolution) => [
      resolution,
      occupiedBuckets(paintTemplateTouches, inputs.templates, resolution),
    ]),
  )
  const bucket = (resolution: number): number => telemetryBuckets.get(resolution) ?? 0
  // Every source row is deleted once and every occupied target bucket is inserted once.
  const telemetryBucketMutations =
    2 * bucket(60) + 2 * bucket(300) + 2 * bucket(900) + 2 * bucket(3_600) + bucket(21_600)

  const reporterTilePairs =
    (inputs.activeUsers + (serverOnlyTileObservations > 0 ? 1 : 0)) * inputs.coveredTiles
  const tileHistoryBuckets = new Map(
    TILE_HISTORY_RESOLUTIONS.filter((resolution) => resolution > 0).map((resolution) => [
      resolution,
      occupiedBuckets(tileObservations, reporterTilePairs, resolution),
    ]),
  )
  const tileBucket = (resolution: number): number => tileHistoryBuckets.get(resolution) ?? 0
  const tileHistoryMutations =
    2 * tileObservations + 2 * tileBucket(3_600) + 2 * tileBucket(21_600) + tileBucket(86_400)

  const d1LogicalRowMutations =
    2 * paintEvents +
    paintTemplateTouches +
    telemetryBucketMutations +
    tileObservations * (2 + inputs.averageTemplatesPerTile) +
    tileHistoryMutations
  // D1 bills table rows and changed index rows. This ceiling charges every mutation as if every
  // applicable index also changed; live analytics provides the actual value for calibration.
  const paintRowsWritten = 4 * paintEvents + 2 * paintTemplateTouches + 2 * telemetryBucketMutations
  const tileRowsWritten =
    tileObservations * (3 + 2 * inputs.averageTemplatesPerTile) + 2 * tileHistoryMutations
  const d1RowsWrittenUpperBound = paintRowsWritten + tileRowsWritten

  const globalActivePaintMinutes = occupiedBuckets(classifiedPaintEvents, 1, 60)
  const durableObjectAlarmRequests = globalActivePaintMinutes
  const durableObjectRequests = paintReportRequests + durableObjectAlarmRequests
  const workerRequests =
    paintReportRequests +
    tileOfferRequests +
    tileUploadRequests +
    statusRequests +
    inputs.otherWorkerRequestsPerDay

  const r2ClassAOperations = newTileVersions
  const r2ClassBOperations =
    tileOffers +
    tileObservations * inputs.averageTemplatesPerTile +
    paintTileTouches +
    paintTemplateTouches
  const r2StorageGrowthBytes = newTileVersions * inputs.averageTileBytes

  const telemetryRows =
    bucket(60) * retainedBandDays(inputs.historyDays, 0, 0.25) +
    bucket(300) * retainedBandDays(inputs.historyDays, 0.25, 1) +
    bucket(900) * retainedBandDays(inputs.historyDays, 1, 7) +
    bucket(3_600) * retainedBandDays(inputs.historyDays, 7, 30) +
    bucket(21_600) * retainedBandDays(inputs.historyDays, 30)
  const tileHistoryRows =
    tileObservations * retainedBandDays(inputs.historyDays, 0, 1) +
    tileBucket(3_600) * retainedBandDays(inputs.historyDays, 1, 7) +
    tileBucket(21_600) * retainedBandDays(inputs.historyDays, 7, 30) +
    tileBucket(86_400) * retainedBandDays(inputs.historyDays, 30)
  const contributionPairs = inputs.activeUsers * inputs.templates
  const contributionRowsPerDay = occupiedBuckets(
    paintTemplateTouches,
    contributionPairs,
    DAY_SECONDS,
  )
  // applied_events currently has no pruning path. Its one row per paint event is cumulative.
  const d1LogicalRows =
    paintEvents * inputs.historyDays +
    contributionRowsPerDay * inputs.historyDays +
    telemetryRows +
    tileHistoryRows +
    inputs.persistentD1Rows
  const d1Bytes = d1LogicalRows * inputs.d1BytesPerLogicalRow
  const r2Bytes = r2StorageGrowthBytes * inputs.historyDays

  const fixedWorkerRequests = workerRequests - paintReportRequests
  const maximumPaintRequests = Math.min(
    FREE_TIER_LIMITS.workerRequestsPerDay - fixedWorkerRequests,
    FREE_TIER_LIMITS.durableObjectRequestsPerDay - durableObjectAlarmRequests,
  )
  const nonBatchableLimitExceeded =
    d1RowsRead > FREE_TIER_LIMITS.d1RowsReadPerDay ||
    d1RowsWrittenUpperBound > FREE_TIER_LIMITS.d1RowsWrittenPerDay ||
    d1Bytes > FREE_TIER_LIMITS.d1StorageBytes ||
    r2ClassAOperations > FREE_TIER_LIMITS.r2ClassAPerMonth / DAYS_PER_MONTH ||
    r2ClassBOperations > FREE_TIER_LIMITS.r2ClassBPerMonth / DAYS_PER_MONTH ||
    r2Bytes > FREE_TIER_LIMITS.r2StorageBytes
  const minimumPaintBatchWindowSecondsForFreeTier = nonBatchableLimitExceeded
    ? null
    : minimumBatchWindow(
        paintEvents,
        paintRatePerUserSecond,
        inputs.maxPaintEventsPerReport,
        maximumPaintRequests,
      )

  const singleShardPeakRequestsPerSecond =
    inputs.activeUsers *
    (paintRatePerUserSecond /
      Math.min(
        inputs.maxPaintEventsPerReport,
        1 + paintRatePerUserSecond * inputs.paintBatchWindowSeconds,
      ))

  const utilizationWithoutFirstLimit = {
    workerRequests: workerRequests / FREE_TIER_LIMITS.workerRequestsPerDay,
    durableObjectRequests: durableObjectRequests / FREE_TIER_LIMITS.durableObjectRequestsPerDay,
    d1RowsRead: d1RowsRead / FREE_TIER_LIMITS.d1RowsReadPerDay,
    d1RowsWritten: d1RowsWrittenUpperBound / FREE_TIER_LIMITS.d1RowsWrittenPerDay,
    d1Storage: d1Bytes / FREE_TIER_LIMITS.d1StorageBytes,
    r2ClassAOperations: r2ClassAOperations / (FREE_TIER_LIMITS.r2ClassAPerMonth / DAYS_PER_MONTH),
    r2ClassBOperations: r2ClassBOperations / (FREE_TIER_LIMITS.r2ClassBPerMonth / DAYS_PER_MONTH),
    r2Storage: r2Bytes / FREE_TIER_LIMITS.r2StorageBytes,
  }
  const firstLimit = Object.entries(utilizationWithoutFirstLimit).reduce(
    (highest, [name, value]) =>
      value > utilizationWithoutFirstLimit[highest]
        ? (name as keyof typeof utilizationWithoutFirstLimit)
        : highest,
    'workerRequests' as keyof typeof utilizationWithoutFirstLimit,
  )

  return {
    traffic: {
      paintEvents,
      classifiedPaintEvents,
      paintReportRequests,
      tileOffers,
      tileOfferRequests,
      tileUploadRequests,
      tileObservations,
      periodicStatusPollRequests,
      offerStatusRefreshRequests,
      lifecycleStatusRefreshRequests,
      statusRequests,
    },
    daily: {
      workerRequests,
      durableObjectRequests,
      durableObjectAlarmRequests,
      d1RowsRead,
      d1LogicalRowMutations,
      d1RowsWrittenUpperBound,
      r2ClassAOperations,
      r2ClassBOperations,
      r2StorageGrowthBytes,
    },
    storage: { d1LogicalRows, d1Bytes, r2Bytes },
    batching: { minimumPaintBatchWindowSecondsForFreeTier },
    sharding: {
      singleShardPeakRequestsPerSecond,
      perTemplateNeeded: singleShardPeakRequestsPerSecond > SINGLE_SHARD_REQUESTS_PER_SECOND_BUDGET,
    },
    utilization: { ...utilizationWithoutFirstLimit, firstLimit },
  }
}
