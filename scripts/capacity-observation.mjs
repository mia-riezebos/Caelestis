import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const WINDOW_HOURS = 24
const AVERAGE_TILE_BYTES = 100_000

const requiredMatch = (text, pattern, name) => {
  const value = text.match(pattern)?.[1]
  if (value === undefined) throw new Error(`could not read ${name} from apps/backend/wrangler.toml`)
  return value
}

export const readCapacityConfiguration = (text) => ({
  accountId: requiredMatch(text, /^\s*account_id\s*=\s*"([^"]+)"/m, 'account_id'),
  databaseId: requiredMatch(text, /^\s*database_id\s*=\s*"([^"]+)"/m, 'database_id'),
  bucketName: requiredMatch(text, /^\s*bucket_name\s*=\s*"([^"]+)"/m, 'bucket_name'),
  scriptName: requiredMatch(text, /^\s*name\s*=\s*"([^"]+)"/m, 'name'),
  season: Number(requiredMatch(text, /^\s*SEASON\s*=\s*"(\d+)"/m, 'SEASON')),
})

const isStatusInsight = (item) =>
  item.query.includes('template_tile_statuses') &&
  item.query.includes('json_group_array') &&
  item.query.includes('group by "templates"."id"')

const includesTable = (item, names) => names.some((name) => item.query.includes(name))

const isPaintInsight = (item) =>
  includesTable(item, ['applied_events', 'telemetry_buckets', 'contributions', 'painters'])

const isTileInsight = (item) =>
  includesTable(item, [
    'canvas_tiles',
    'tile_history',
    'template_tile_statuses',
    'tile_blob_objects',
    'tile_blob_reservations',
  ])

export const sumInsights = (insights) => {
  const statusInsights = insights.filter(isStatusInsight)
  const paintInsights = insights.filter((item) => !isStatusInsight(item) && isPaintInsight(item))
  const tileInsights = insights.filter(
    (item) => !isStatusInsight(item) && !isPaintInsight(item) && isTileInsight(item),
  )
  const classified = new Set([...statusInsights, ...paintInsights, ...tileInsights])
  return {
    rowsRead: insights.reduce((sum, item) => sum + item.totalRowsRead, 0),
    rowsWritten: insights.reduce((sum, item) => sum + item.totalRowsWritten, 0),
    statusRequests: statusInsights.reduce((sum, item) => sum + item.numberOfTimesRun, 0),
    statusRowsRead: statusInsights.reduce((sum, item) => sum + item.totalRowsRead, 0),
    paintRowsRead: paintInsights.reduce((sum, item) => sum + item.totalRowsRead, 0),
    tileRowsRead: tileInsights.reduce((sum, item) => sum + item.totalRowsRead, 0),
    otherRowsRead: insights.reduce(
      (sum, item) => sum + (classified.has(item) ? 0 : item.totalRowsRead),
      0,
    ),
  }
}

const sumGroups = (groups, field) =>
  groups.reduce((sum, group) => sum + Number(group.sum?.[field] ?? 0), 0)

export const operationTotals = (groups) =>
  groups.reduce((totals, group) => {
    const action = group.dimensions.actionType
    totals[action] = (totals[action] ?? 0) + Number(group.sum?.requests ?? 0)
    return totals
  }, {})

const R2_CLASS_A_ACTIONS = new Set([
  'CompleteMultipartUpload',
  'CopyObject',
  'CreateMultipartUpload',
  'ListBuckets',
  'ListMultipartUploads',
  'ListObjects',
  'ListParts',
  'PutBucket',
  'PutBucketCors',
  'PutBucketEncryption',
  'PutBucketLifecycleConfiguration',
  'PutObject',
  'UploadPart',
  'UploadPartCopy',
])
const R2_CLASS_B_ACTIONS = new Set([
  'GetBucketCors',
  'GetBucketEncryption',
  'GetBucketLifecycleConfiguration',
  'GetBucketLocation',
  'GetObject',
  'HeadBucket',
  'HeadObject',
  'UsageSummary',
])

export const classifyR2Operations = (operations) =>
  Object.entries(operations).reduce(
    (totals, [action, requests]) => {
      if (R2_CLASS_A_ACTIONS.has(action)) totals.classA += requests
      if (R2_CLASS_B_ACTIONS.has(action)) totals.classB += requests
      return totals
    },
    { classA: 0, classB: 0 },
  )

export const deriveCapacityCalibration = (
  database,
  insightTotals,
  currentClientDefaults,
  independentActiveUserHours,
) => {
  const reportingUsers = Number(database.active_users)
  // Insights has no HTTP request id with which to distinguish periodic status polls from the one
  // refresh after a successful multi-item offer batch. Keep every measured status call as a
  // periodic-equivalent backfit rather than subtracting tile rows as though they were batches.
  const statusEquivalentUserHours =
    (insightTotals.statusRequests * currentClientDefaults.statusPollIntervalSeconds) / 3_600
  const activeUserHours = independentActiveUserHours ?? statusEquivalentUserHours
  const statusUsers = activeUserHours === 0 ? 0 : Math.max(1, Math.ceil(activeUserHours / 24))
  const activeUsers = Math.max(reportingUsers, statusUsers)
  const activeHoursPerUser = activeUsers === 0 ? 0 : activeUserHours / activeUsers
  const paintEvents = Number(database.paint_events)
  const clientTileObservations = Number(database.client_tile_observations)
  const coveredTiles = Number(database.covered_tiles)
  const logicalRows = Number(database.logical_rows)
  const historyStartSeconds = Number(database.history_start_s)
  const nowSeconds = Math.floor(Date.now() / 1_000)

  return {
    modelInputs: {
      activeUsers,
      activeHoursPerUser,
      templates: Number(database.templates),
      coveredTiles,
      paintEventsPerUserHour: activeUserHours === 0 ? 0 : paintEvents / activeUserHours,
      tileFetchesPerUserHour: activeUserHours === 0 ? 0 : clientTileObservations / activeUserHours,
      averageTemplatesPerPaint: 1,
      averageTilesPerPaint: 1,
      averageTemplatesPerTile:
        coveredTiles === 0 ? 0 : Number(database.template_tile_entries) / coveredTiles,
      classifiedPaintFraction: 1,
      ...currentClientDefaults,
      tileVersionsPerCoveredTileDay:
        coveredTiles === 0 ? 0 : Number(database.distinct_tile_versions) / coveredTiles,
      averageTileBytes: AVERAGE_TILE_BYTES,
      historyDays:
        historyStartSeconds === 0 ? 0 : Math.max(0, (nowSeconds - historyStartSeconds) / 86_400),
      d1BytesPerLogicalRow:
        logicalRows === 0 ? 0 : Number(database.database_size_bytes) / logicalRows,
      d1RowsReadPerStatusRequest:
        insightTotals.statusRequests === 0
          ? 0
          : insightTotals.statusRowsRead / insightTotals.statusRequests,
      d1RowsReadPerPaintReportRequest:
        paintEvents === 0 ? 0 : insightTotals.paintRowsRead / paintEvents,
      d1RowsReadPerTileObservation:
        clientTileObservations === 0 ? 0 : insightTotals.tileRowsRead / clientTileObservations,
      otherD1RowsReadPerDay: insightTotals.otherRowsRead,
      otherWorkerRequestsPerDay: 0,
      persistentD1Rows: Number(database.persistent_rows),
    },
    activeTimeCalibration: {
      source:
        independentActiveUserHours === undefined
          ? 'status-equivalent-backfit'
          : 'independent-user-hours',
      activeUserHours,
      statusEquivalentUserHours,
      workloadRatesScalable: independentActiveUserHours !== undefined,
      estimateUse:
        independentActiveUserHours === undefined
          ? 'observed-window-backfit-only'
          : 'scalable-point-estimate',
      variableTrafficRateUpperBoundsPerUserHour: {
        paintEvents: null,
        tileObservations: null,
      },
    },
  }
}

export const deriveModelInputs = (database, insightTotals, currentClientDefaults) =>
  deriveCapacityCalibration(database, insightTotals, currentClientDefaults).modelInputs

const wranglerJson = (args) =>
  JSON.parse(
    execFileSync('pnpm', ['--dir', 'apps/backend', 'exec', 'wrangler', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1_024 * 1_024,
    }),
  )

export const capacityObservationSql = (configuration, since) => {
  const sinceMilliseconds = since.getTime()
  const sinceSeconds = Math.floor(sinceMilliseconds / 1_000)
  return `
    WITH current_tiles AS (
      SELECT version_tiles.tile_x, version_tiles.tile_y
      FROM version_tiles
      INNER JOIN template_versions ON template_versions.id = version_tiles.version_id
      INNER JOIN templates
        ON templates.id = template_versions.template_id
       AND templates.current_version_id = template_versions.id
      WHERE templates.season = ${configuration.season}
    ), active_reporters AS (
      SELECT wplace_user_id AS id
      FROM applied_events
      WHERE seen_at_ms >= ${sinceMilliseconds}
      UNION
      SELECT reported_by_user_id AS id
      FROM tile_history
      WHERE bucket_start_s >= ${sinceSeconds} AND reported_by_user_id <> 0
    ), relevant_hashes AS (
      SELECT DISTINCT sha256
      FROM tile_history
      WHERE bucket_start_s >= ${sinceSeconds}
    )
    SELECT
      (SELECT COUNT(*) FROM templates WHERE season = ${configuration.season}) AS templates,
      (SELECT COUNT(*) FROM current_tiles) AS template_tile_entries,
      (SELECT COUNT(*) FROM (SELECT DISTINCT tile_x, tile_y FROM current_tiles)) AS covered_tiles,
      (SELECT COUNT(*) FROM applied_events WHERE seen_at_ms >= ${sinceMilliseconds}) AS paint_events,
      (SELECT COUNT(*) FROM active_reporters) AS active_users,
      (SELECT COUNT(*) FROM tile_history
        WHERE resolution_s = 0 AND bucket_start_s >= ${sinceSeconds}
          AND reported_by_user_id <> 0) AS client_tile_observations,
      (SELECT COUNT(*) FROM tile_history
        WHERE resolution_s = 0 AND bucket_start_s >= ${sinceSeconds}
          AND reported_by_user_id = 0) AS server_tile_observations,
      (SELECT COUNT(*) FROM relevant_hashes) AS distinct_tile_versions,
      (SELECT MIN(value) FROM (
        SELECT MIN(seen_at_ms) / 1000 AS value FROM applied_events
        UNION ALL SELECT MIN(bucket_start_s) FROM tile_history
        UNION ALL SELECT MIN(bucket_start_s) FROM telemetry_buckets
      ) WHERE value IS NOT NULL) AS history_start_s,
      (
        (SELECT COUNT(*) FROM server_settings) +
        (SELECT COUNT(*) FROM nodes) +
        (SELECT COUNT(*) FROM template_versions) +
        (SELECT COUNT(*) FROM templates) +
        (SELECT COUNT(*) FROM version_tiles) +
        (SELECT COUNT(*) FROM access_tokens) +
        (SELECT COUNT(*) FROM painters) +
        (SELECT COUNT(*) FROM canvas_tiles) +
        (SELECT COUNT(*) FROM template_tile_statuses) +
        (SELECT COUNT(*) FROM tile_blob_gc_state) +
        (SELECT COUNT(*) FROM tile_blob_objects) +
        (SELECT COUNT(*) FROM tile_blob_reservations)
      ) AS persistent_rows,
      (
        (SELECT COUNT(*) FROM server_settings) +
        (SELECT COUNT(*) FROM nodes) +
        (SELECT COUNT(*) FROM template_versions) +
        (SELECT COUNT(*) FROM templates) +
        (SELECT COUNT(*) FROM version_tiles) +
        (SELECT COUNT(*) FROM access_tokens) +
        (SELECT COUNT(*) FROM telemetry_buckets) +
        (SELECT COUNT(*) FROM contributions) +
        (SELECT COUNT(*) FROM applied_events) +
        (SELECT COUNT(*) FROM painters) +
        (SELECT COUNT(*) FROM tile_history) +
        (SELECT COUNT(*) FROM canvas_tiles) +
        (SELECT COUNT(*) FROM template_tile_statuses) +
        (SELECT COUNT(*) FROM tile_blob_gc_state) +
        (SELECT COUNT(*) FROM tile_blob_objects) +
        (SELECT COUNT(*) FROM tile_blob_reservations)
      ) AS logical_rows
  `
}

const queryDatabase = (configuration, since) => {
  const sql = capacityObservationSql(configuration, since)
  const response = wranglerJson(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql])[0]
  if (response?.success !== true || response.results?.[0] === undefined) {
    throw new Error('remote D1 observation query failed')
  }
  return { ...response.results[0], database_size_bytes: response.meta.size_after }
}

const graphql = async (token, query) => {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await response.json()
  if (!response.ok || body.errors?.length > 0) {
    throw new Error(
      body.errors?.map((error) => error.message).join('; ') ?? `HTTP ${response.status}`,
    )
  }
  return body.data
}

const queryCloudflareMetrics = async (configuration, start, end) => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone command does not run through Turbo.
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (token === undefined || token === '') return { unavailable: 'CLOUDFLARE_API_TOKEN is not set' }
  const quoted = (value) => JSON.stringify(value)
  const account = `viewer { accounts(filter: {accountTag: ${quoted(configuration.accountId)}})`
  const range = `datetime_geq: ${quoted(start.toISOString())}, datetime_lt: ${quoted(end.toISOString())}`
  const close = '}'

  const workers = await graphql(
    token,
    `{ ${account} { workersInvocationsAdaptive(limit: 10000, filter: {
      scriptName: ${quoted(configuration.scriptName)}, ${range}
    }) { sum { requests } } } ${close} }`,
  )
  const durableObjects = await graphql(
    token,
    `{ ${account} { durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {
      scriptName: ${quoted(configuration.scriptName)}, ${range}
    }) { sum { requests } dimensions { type } } } ${close} }`,
  )
  const d1 = await graphql(
    token,
    `{ ${account} {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: {
        databaseId: ${quoted(configuration.databaseId)}, ${range}
      }) { sum { rowsRead rowsWritten readQueries writeQueries } }
      d1StorageAdaptiveGroups(limit: 1, filter: {
        databaseId: ${quoted(configuration.databaseId)}, ${range}
      }) { max { databaseSizeBytes } }
    } ${close} }`,
  )
  const r2 = await graphql(
    token,
    `{ ${account} {
      r2OperationsAdaptiveGroups(limit: 10000, filter: {
        bucketName: ${quoted(configuration.bucketName)}, ${range}
      }) { sum { requests } dimensions { actionType } }
      r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC], filter: {
        bucketName: ${quoted(configuration.bucketName)}, ${range}
      }) { max { objectCount payloadSize metadataSize } dimensions { datetime } }
    } ${close} }`,
  )

  const workerGroups = workers.viewer.accounts[0]?.workersInvocationsAdaptive ?? []
  const durableObjectGroups =
    durableObjects.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? []
  const d1Account = d1.viewer.accounts[0] ?? {}
  const r2Account = r2.viewer.accounts[0] ?? {}
  return {
    workerRequests: sumGroups(workerGroups, 'requests'),
    durableObjectRequests: sumGroups(durableObjectGroups, 'requests'),
    durableObjectRequestsByType: durableObjectGroups.reduce((totals, group) => {
      const type = group.dimensions.type
      totals[type] = (totals[type] ?? 0) + Number(group.sum?.requests ?? 0)
      return totals
    }, {}),
    d1: {
      rowsRead: sumGroups(d1Account.d1AnalyticsAdaptiveGroups ?? [], 'rowsRead'),
      rowsWritten: sumGroups(d1Account.d1AnalyticsAdaptiveGroups ?? [], 'rowsWritten'),
      databaseSizeBytes: Number(
        d1Account.d1StorageAdaptiveGroups?.[0]?.max?.databaseSizeBytes ?? 0,
      ),
    },
    r2: {
      operations: operationTotals(r2Account.r2OperationsAdaptiveGroups ?? []),
      storage: r2Account.r2StorageAdaptiveGroups?.[0]?.max ?? null,
    },
  }
}

export const comparison = (estimate, observed) => {
  const observedR2 =
    observed.r2?.operations === undefined ? null : classifyR2Operations(observed.r2.operations)
  return {
    workerRequests: {
      model: estimate.daily.workerRequests,
      observed: observed.workerRequests ?? null,
    },
    durableObjectRequests: {
      model: estimate.daily.durableObjectRequests,
      observed: observed.durableObjectRequests ?? null,
    },
    d1RowsRead: {
      model: estimate.daily.d1RowsRead,
      observed: observed.d1?.rowsRead ?? null,
    },
    d1RowsWritten: {
      modelLogical: estimate.daily.d1LogicalRowMutations,
      modelUpperBound: estimate.daily.d1RowsWrittenUpperBound,
      observed: observed.d1?.rowsWritten ?? null,
    },
    r2StorageBytes: {
      model: estimate.storage.r2Bytes,
      observed: observed.r2?.storage?.payloadSize ?? null,
    },
    r2ClassAOperations: {
      model: estimate.daily.r2ClassAOperations,
      observed: observedR2?.classA ?? null,
    },
    r2ClassBOperations: {
      model: estimate.daily.r2ClassBOperations,
      observed: observedR2?.classB ?? null,
    },
  }
}

const main = async () => {
  const { CURRENT_CLIENT_CAPACITY_DEFAULTS, estimateCapacity } = await import(
    '../apps/backend/dist/capacity/model.js'
  )
  const configuration = readCapacityConfiguration(
    readFileSync('apps/backend/wrangler.toml', 'utf8'),
  )
  const end = new Date()
  const start = new Date(end.getTime() - WINDOW_HOURS * 3_600_000)
  const database = queryDatabase(configuration, start)
  const insights = wranglerJson([
    'd1',
    'insights',
    'DB',
    '--time-period',
    '1d',
    '--sort-type',
    'sum',
    '--sort-by',
    'writes',
    '--limit',
    '1000',
    '--json',
  ])
  const insightTotals = sumInsights(insights)
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone command does not run through Turbo.
  const configuredActiveUserHours = process.env.CAELESTIS_ACTIVE_USER_HOURS
  const independentActiveUserHours =
    configuredActiveUserHours === undefined ? undefined : Number(configuredActiveUserHours)
  if (
    independentActiveUserHours !== undefined &&
    (!Number.isFinite(independentActiveUserHours) || independentActiveUserHours < 0)
  ) {
    throw new RangeError('CAELESTIS_ACTIVE_USER_HOURS must be a finite non-negative number')
  }
  const calibration = deriveCapacityCalibration(
    database,
    insightTotals,
    CURRENT_CLIENT_CAPACITY_DEFAULTS,
    independentActiveUserHours,
  )
  const modelInputs = calibration.modelInputs
  const estimate = estimateCapacity(modelInputs)
  const observed = await queryCloudflareMetrics(configuration, start, end)

  console.log(
    JSON.stringify(
      {
        window: { start: start.toISOString(), end: end.toISOString(), hours: WINDOW_HOURS },
        database,
        insightTotals,
        activeTimeCalibration: calibration.activeTimeCalibration,
        modelInputs,
        estimate,
        observed,
        comparison: comparison(estimate, observed),
      },
      null,
      2,
    ),
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
