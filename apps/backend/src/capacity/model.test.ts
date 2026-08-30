import { describe, expect, it } from 'vitest'
import { type CapacityInputs, CURRENT_CLIENT_CAPACITY_DEFAULTS, estimateCapacity } from './model.js'

const inputs = (patch: Partial<CapacityInputs> = {}): CapacityInputs => ({
  activeUsers: 10,
  activeHoursPerUser: 4,
  templates: 5,
  coveredTiles: 20,
  paintEventsPerUserHour: 10,
  tileFetchesPerUserHour: 30,
  averageTemplatesPerPaint: 1,
  averageTilesPerPaint: 1,
  averageTemplatesPerTile: 1,
  classifiedPaintFraction: 1,
  ...CURRENT_CLIENT_CAPACITY_DEFAULTS,
  tileVersionsPerCoveredTileDay: 4,
  averageTileBytes: 100_000,
  historyDays: 30,
  d1BytesPerLogicalRow: 200,
  otherWorkerRequestsPerDay: 0,
  ...patch,
})

describe('capacity model', () => {
  it('models the current client as unbatched paints, 250 ms offers, and 30 second polls', () => {
    const estimate = estimateCapacity(inputs())

    expect(estimate.traffic.paintEvents).toBe(400)
    expect(estimate.traffic.paintReportRequests).toBe(400)
    expect(estimate.traffic.tileOffers).toBe(1_200)
    expect(estimate.traffic.tileOfferRequests).toBeCloseTo(1_197.505, 3)
    expect(estimate.traffic.statusPollRequests).toBe(4_800)
  })

  it('shows that status polling nearly exhausts Workers Free for 100 eight-hour clients', () => {
    const estimate = estimateCapacity(
      inputs({
        activeUsers: 100,
        activeHoursPerUser: 8,
        paintEventsPerUserHour: 10,
        tileFetchesPerUserHour: 0,
        tileVersionsPerCoveredTileDay: 0,
      }),
    )

    expect(estimate.traffic.statusPollRequests).toBe(96_000)
    expect(estimate.daily.workerRequests).toBe(104_000)
    expect(estimate.utilization.firstLimit).toBe('workerRequests')
    expect(estimate.batching.minimumPaintBatchWindowSecondsForFreeTier).toBeNull()
  })

  it('solves a hypothetical paint batch window when fixed traffic leaves enough room', () => {
    const estimate = estimateCapacity(
      inputs({
        activeUsers: 100,
        activeHoursPerUser: 4,
        paintEventsPerUserHour: 200,
        tileFetchesPerUserHour: 0,
        tileVersionsPerCoveredTileDay: 0,
        maxPaintEventsPerReport: 64,
      }),
    )

    expect(estimate.daily.workerRequests).toBe(128_000)
    expect(estimate.batching.minimumPaintBatchWindowSecondsForFreeTier).toBeCloseTo(9.692, 3)
  })

  it('keeps R2 tile blobs cumulative when SQL history compacts', () => {
    const oneMonth = estimateCapacity(inputs({ historyDays: 30 }))
    const twoMonths = estimateCapacity(inputs({ historyDays: 60 }))

    expect(twoMonths.storage.r2Bytes).toBe(oneMonth.storage.r2Bytes * 2)
    expect(twoMonths.daily.r2StorageGrowthBytes).toBe(oneMonth.daily.r2StorageGrowthBytes)
  })

  it('amortizes every decay-ladder insert and delete into D1 writes', () => {
    const quiet = estimateCapacity(
      inputs({
        activeUsers: 1,
        activeHoursPerUser: 1,
        templates: 1,
        coveredTiles: 0,
        paintEventsPerUserHour: 1,
        tileFetchesPerUserHour: 0,
        tileVersionsPerCoveredTileDay: 0,
      }),
    )

    // One paint costs its event, painter, contribution, and the activity bucket's eventual folds.
    expect(quiet.daily.d1LogicalRowMutations).toBeGreaterThan(5)
    expect(quiet.daily.d1RowsWrittenUpperBound).toBeGreaterThan(10)
    expect(quiet.storage.d1LogicalRows).toBeGreaterThan(30)
  })

  it('reserves per-template sharding for single-object throughput, not free-tier quota', () => {
    const ordinary = estimateCapacity(inputs())
    const burst = estimateCapacity(
      inputs({ activeUsers: 1_000, paintEventsPerUserHour: 1_000, activeHoursPerUser: 1 }),
    )

    expect(ordinary.sharding.perTemplateNeeded).toBe(false)
    expect(burst.sharding.singleShardPeakRequestsPerSecond).toBeCloseTo(277.778, 3)
    expect(burst.sharding.perTemplateNeeded).toBe(true)
  })

  it('rejects impossible client and workload values', () => {
    expect(() => estimateCapacity(inputs({ activeHoursPerUser: 25 }))).toThrow(/activeHoursPerUser/)
    expect(() => estimateCapacity(inputs({ classifiedPaintFraction: 1.1 }))).toThrow(
      /classifiedPaintFraction/,
    )
    expect(() => estimateCapacity(inputs({ maxTileOffersPerRequest: 0 }))).toThrow(
      /maxTileOffersPerRequest/,
    )
  })
})
