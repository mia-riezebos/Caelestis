import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyR2Operations,
  deriveModelInputs,
  operationTotals,
  readCapacityConfiguration,
  sumInsights,
} from './capacity-observation.mjs'

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
    ]),
    { rowsRead: 102, rowsWritten: 4, statusRequests: 12, statusRowsRead: 100 },
  )
})

test('derives rates from measured client-open time', () => {
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
        logical_rows: 100,
        database_size_bytes: 25_000,
        history_start_s: 5 * 86_400,
      },
      { rowsRead: 12_000, rowsWritten: 100, statusRequests: 480, statusRowsRead: 9_600 },
      {
        paintBatchWindowSeconds: 0,
        maxPaintEventsPerReport: 1,
        tileOfferBatchWindowSeconds: 0.25,
        maxTileOffersPerRequest: 64,
        statusPollIntervalSeconds: 30,
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
    assert.equal(inputs.otherD1RowsReadPerDay, 2_400)
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
