import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capacityObservationSql,
  classifyR2Operations,
  comparison,
  deriveCapacityCalibration,
  deriveModelInputs,
  operationTotals,
  parseIndependentActiveUserHours,
  readCapacityConfiguration,
  sumInsights,
} from './capacity-observation.mjs'

test('observes content-addressed hashes and persistent schema rows', () => {
  const sql = capacityObservationSql({ season: 7 }, new Date('2026-08-30T00:00:00Z'))

  assert.match(sql, /SELECT DISTINCT sha256/)
  assert.match(sql, /AS persistent_rows/)
  assert.doesNotMatch(sql, /SELECT DISTINCT season, tile_x, tile_y, sha256/)
})

test('reads only public resource identifiers from wrangler configuration', () => {
  assert.deepEqual(
    readCapacityConfiguration(`
      name = "backend"
      account_id = "account"
      bucket_name = "blobs"
      database_id = "database"
      SEASON = "7"
    `),
    {
      accountId: 'account',
      bucketName: 'blobs',
      databaseId: 'database',
      scriptName: 'backend',
      season: 7,
    },
  )
})

test('rejects blank or invalid independent active-user hours', () => {
  assert.equal(parseIndependentActiveUserHours(undefined), undefined)
  assert.equal(parseIndependentActiveUserHours(' 2.5 '), 2.5)
  assert.throws(() => parseIndependentActiveUserHours(''), /must not be blank/)
  assert.throws(() => parseIndependentActiveUserHours('  '), /must not be blank/)
  assert.throws(() => parseIndependentActiveUserHours('0'), /finite positive/)
  assert.throws(() => parseIndependentActiveUserHours('-1'), /finite positive/)
  assert.throws(() => parseIndependentActiveUserHours('nope'), /finite positive/)
})

test('reduces D1 insights and identifies status reads', () => {
  assert.deepEqual(
    sumInsights([
      {
        query: 'select template_tile_statuses json_group_array group by "templates"."id"',
        totalRowsRead: 100,
        totalRowsWritten: 0,
        numberOfTimesRun: 12,
      },
      {
        query: 'insert into telemetry_buckets',
        totalRowsRead: 2,
        totalRowsWritten: 4,
        numberOfTimesRun: 2,
      },
      {
        query: 'select from canvas_tiles',
        totalRowsRead: 6,
        totalRowsWritten: 0,
        numberOfTimesRun: 3,
      },
      {
        query: 'select from access_tokens',
        totalRowsRead: 4,
        totalRowsWritten: 0,
        numberOfTimesRun: 4,
      },
    ]),
    {
      rowsRead: 112,
      rowsWritten: 4,
      statusRequests: 12,
      statusRowsRead: 100,
      paintRowsRead: 2,
      tileRowsRead: 6,
      otherRowsRead: 4,
    },
  )
})

test('derives backfit rates from the status-equivalent clock', () => {
  const originalNow = Date.now
  Date.now = () => 10 * 86_400_000
  try {
    const inputs = deriveModelInputs(
      {
        active_users: 2,
        templates: 4,
        covered_tiles: 10,
        template_tile_entries: 15,
        paint_events: 8,
        client_tile_observations: 16,
        distinct_tile_versions: 20,
        persistent_rows: 40,
        logical_rows: 100,
        database_size_bytes: 25_000,
        history_start_s: 5 * 86_400,
      },
      {
        rowsRead: 12_000,
        rowsWritten: 100,
        statusRequests: 480,
        statusRowsRead: 9_600,
        paintRowsRead: 160,
        tileRowsRead: 320,
        otherRowsRead: 2_400,
      },
      {
        paintBatchWindowSeconds: 0,
        maxPaintEventsPerReport: 1,
        tileOfferBatchWindowSeconds: 0.25,
        maxTileOffersPerRequest: 64,
        statusPollIntervalSeconds: 30,
        statusRefreshesPerTileOfferRequest: 1,
        lifecycleStatusRefreshesPerUserDay: 2,
      },
    )

    assert.equal(inputs.activeHoursPerUser, 2)
    assert.equal(inputs.paintEventsPerUserHour, 2)
    assert.equal(inputs.tileFetchesPerUserHour, 4)
    assert.equal(inputs.averageTemplatesPerTile, 1.5)
    assert.equal(inputs.tileVersionsPerCoveredTileDay, 2)
    assert.equal(inputs.historyDays, 5)
    assert.equal(inputs.d1BytesPerLogicalRow, 250)
    assert.equal(inputs.d1RowsReadPerStatusRequest, 20)
    assert.equal(inputs.d1RowsReadPerPaintReportRequest, 20)
    assert.equal(inputs.d1RowsReadPerTileObservation, 20)
    assert.equal(inputs.otherD1RowsReadPerDay, 2_400)
    assert.equal(inputs.persistentD1Rows, 40)
  } finally {
    Date.now = originalNow
  }
})

test('groups R2 operation counts by action', () => {
  assert.deepEqual(
    operationTotals([
      { dimensions: { actionType: 'PutObject' }, sum: { requests: 3 } },
      { dimensions: { actionType: 'PutObject' }, sum: { requests: 2 } },
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 5 } },
    ]),
    { PutObject: 5, GetObject: 5 },
  )
})

test('classifies billable R2 operations', () => {
  assert.deepEqual(
    classifyR2Operations({ PutObject: 3, GetObject: 5, HeadObject: 2, Unknown: 100 }),
    { classA: 3, classB: 7 },
  )
})

test('preserves unavailable R2 operation metrics as null', () => {
  const compared = comparison(
    {
      daily: {
        workerRequests: 1,
        durableObjectRequests: 2,
        d1RowsRead: 3,
        d1LogicalRowMutations: 4,
        d1RowsWrittenUpperBound: 5,
        r2ClassAOperations: 6,
        r2ClassBOperations: 7,
      },
      storage: { r2Bytes: 8 },
    },
    { unavailable: 'token missing' },
  )

  assert.equal(compared.r2ClassAOperations.observed, null)
  assert.equal(compared.r2ClassBOperations.observed, null)
})

test('derives a periodic-equivalent backfit for status-only clients', () => {
  const inputs = deriveModelInputs(
    {
      active_users: 0,
      templates: 1,
      covered_tiles: 0,
      template_tile_entries: 0,
      paint_events: 0,
      client_tile_observations: 0,
      distinct_tile_versions: 0,
      persistent_rows: 5,
      logical_rows: 5,
      database_size_bytes: 500,
      history_start_s: 0,
    },
    {
      rowsRead: 1_200,
      rowsWritten: 0,
      statusRequests: 120,
      statusRowsRead: 1_200,
      paintRowsRead: 0,
      tileRowsRead: 0,
      otherRowsRead: 0,
    },
    {
      paintBatchWindowSeconds: 0,
      maxPaintEventsPerReport: 1,
      tileOfferBatchWindowSeconds: 0.25,
      maxTileOffersPerRequest: 64,
      statusPollIntervalSeconds: 30,
      statusRefreshesPerTileOfferRequest: 1,
      lifecycleStatusRefreshesPerUserDay: 2,
    },
  )

  assert.equal(inputs.activeUsers, 1)
  assert.equal(inputs.activeHoursPerUser, 1)
})

test('marks status-equivalent workload rates as unsafe to scale', () => {
  const calibration = deriveCapacityCalibration(
    {
      active_users: 1,
      templates: 1,
      covered_tiles: 0,
      template_tile_entries: 0,
      paint_events: 4,
      client_tile_observations: 0,
      distinct_tile_versions: 0,
      persistent_rows: 1,
      logical_rows: 1,
      database_size_bytes: 100,
      history_start_s: 0,
    },
    {
      rowsRead: 100,
      rowsWritten: 0,
      statusRequests: 120,
      statusRowsRead: 100,
      paintRowsRead: 0,
      tileRowsRead: 0,
      otherRowsRead: 0,
    },
    {
      paintBatchWindowSeconds: 0,
      maxPaintEventsPerReport: 1,
      tileOfferBatchWindowSeconds: 0.25,
      maxTileOffersPerRequest: 64,
      statusPollIntervalSeconds: 30,
      statusRefreshesPerTileOfferRequest: 1,
      lifecycleStatusRefreshesPerUserDay: 2,
    },
  )

  assert.equal(calibration.activeTimeCalibration.source, 'status-equivalent-backfit')
  assert.equal(calibration.activeTimeCalibration.workloadRatesScalable, false)
  assert.equal(calibration.activeTimeCalibration.estimateUse, 'observed-window-backfit-only')
  assert.deepEqual(calibration.activeTimeCalibration.variableTrafficRateUpperBoundsPerUserHour, {
    paintEvents: null,
    tileObservations: null,
  })
})

test('uses independently measured user-hours for scalable workload rates', () => {
  const database = {
    active_users: 2,
    templates: 1,
    covered_tiles: 0,
    template_tile_entries: 0,
    paint_events: 8,
    client_tile_observations: 16,
    distinct_tile_versions: 0,
    persistent_rows: 1,
    logical_rows: 1,
    database_size_bytes: 100,
    history_start_s: 0,
  }
  const insights = {
    rowsRead: 100,
    rowsWritten: 0,
    statusRequests: 480,
    statusRowsRead: 100,
    paintRowsRead: 0,
    tileRowsRead: 0,
    otherRowsRead: 0,
  }
  const defaults = {
    paintBatchWindowSeconds: 0,
    maxPaintEventsPerReport: 1,
    tileOfferBatchWindowSeconds: 0.25,
    maxTileOffersPerRequest: 64,
    statusPollIntervalSeconds: 30,
    statusRefreshesPerTileOfferRequest: 1,
    lifecycleStatusRefreshesPerUserDay: 2,
  }
  const calibration = deriveCapacityCalibration(database, insights, defaults, 2)

  assert.equal(calibration.activeTimeCalibration.source, 'independent-user-hours')
  assert.equal(calibration.activeTimeCalibration.workloadRatesScalable, true)
  assert.equal(calibration.activeTimeCalibration.estimateUse, 'scalable-point-estimate')
  assert.equal(calibration.modelInputs.activeHoursPerUser, 1)
  assert.equal(calibration.modelInputs.paintEventsPerUserHour, 4)
  assert.equal(calibration.modelInputs.tileFetchesPerUserHour, 8)
  assert.throws(() => deriveCapacityCalibration(database, insights, defaults, 0), /finite positive/)
})

test('preserves status and tile-read totals across a multi-item partial-upload batch', () => {
  const inputs = deriveModelInputs(
    {
      active_users: 1,
      templates: 1,
      covered_tiles: 64,
      template_tile_entries: 64,
      paint_events: 0,
      client_tile_observations: 64,
      distinct_tile_versions: 8,
      persistent_rows: 5,
      logical_rows: 5,
      database_size_bytes: 500,
      history_start_s: 0,
    },
    {
      rowsRead: 7_600,
      rowsWritten: 0,
      statusRequests: 120,
      statusRowsRead: 1_200,
      paintRowsRead: 0,
      tileRowsRead: 6_400,
      otherRowsRead: 0,
    },
    {
      paintBatchWindowSeconds: 0,
      maxPaintEventsPerReport: 1,
      tileOfferBatchWindowSeconds: 0.25,
      maxTileOffersPerRequest: 64,
      statusPollIntervalSeconds: 30,
      statusRefreshesPerTileOfferRequest: 1,
      lifecycleStatusRefreshesPerUserDay: 2,
    },
  )

  assert.equal(inputs.activeHoursPerUser * (3_600 / inputs.statusPollIntervalSeconds), 120)
  assert.equal(inputs.tileFetchesPerUserHour * inputs.activeHoursPerUser, 64)
  assert.equal(
    inputs.d1RowsReadPerTileObservation * inputs.tileFetchesPerUserHour * inputs.activeHoursPerUser,
    6_400,
  )
})
