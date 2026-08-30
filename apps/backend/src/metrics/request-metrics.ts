import { AsyncLocalStorage } from 'node:async_hooks'
import { parseClientMetricsAccept } from '@caelestis/shared'

export type CacheOutcome = 'none' | 'hit' | 'miss' | 'stale' | 'not-modified'
export type TileOfferBatchOutcome =
  | 'none'
  | 'requested'
  | 'accepted'
  | 'already-known'
  | 'rejected'
  | 'failed'

export interface TileOfferCounts {
  readonly requested: number
  readonly accepted: number
  readonly alreadyKnown: number
  readonly rejected: number
}

interface RequestMetricState {
  readonly route: string
  readonly method: string
  readonly client: string
  readonly clientVersion: string
  readonly syncTransport: string
  readonly reconciliationReason: string
  cacheOutcome: CacheOutcome
  tileOfferOutcome: TileOfferBatchOutcome
  tileOfferCounts: TileOfferCounts
  d1RowsRead: number
  d1RowsWritten: number
  d1MeasuredQueries: number
  d1UnmeasuredQueries: number
}

type MetricDataset = Pick<AnalyticsEngineDataset, 'writeDataPoint'>

const requestMetricStorage = new AsyncLocalStorage<RequestMetricState>()

const route = (method: string, pattern: string): string => `${method} ${pattern}`
const metricMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const normalizeMetricMethod = (method: string): string => {
  const normalized = method.toUpperCase()
  return metricMethods.has(normalized) ? normalized : 'OTHER'
}
const exactRoutes = new Set([
  '/health',
  '/server',
  '/manifest',
  '/admin/server',
  '/admin/tokens',
  '/admin/nodes',
  '/admin/templates',
  '/telemetry/status',
  '/telemetry/alarms',
  '/telemetry/history',
  '/telemetry/contributions',
  '/telemetry/leaderboard',
  '/telemetry/canvas',
  '/telemetry/tiles/offers',
  '/telemetry/paints',
])

/** A finite route vocabulary: request paths containing ids, hashes, or tokens never reach metrics. */
export const normalizeMetricRoute = (method: string, pathname: string): string => {
  const verb = normalizeMetricMethod(method)
  if (verb === 'OTHER') return route(verb, 'other')
  if (exactRoutes.has(pathname)) return route(verb, pathname)
  if (/^\/admin\/tokens\/[^/]+$/.test(pathname)) return route(verb, '/admin/tokens/:tokenHash')
  if (/^\/admin\/nodes\/[^/]+\/subtree$/.test(pathname))
    return route(verb, '/admin/nodes/:id/subtree')
  if (/^\/admin\/nodes\/[^/]+$/.test(pathname)) return route(verb, '/admin/nodes/:id')
  if (/^\/admin\/templates\/[^/]+\/versions$/.test(pathname))
    return route(verb, '/admin/templates/:id/versions')
  if (/^\/admin\/templates\/[^/]+$/.test(pathname)) return route(verb, '/admin/templates/:id')
  if (/^\/chunks\/[^/]+$/.test(pathname)) return route(verb, '/chunks/:hash')
  if (/^\/tiles\/[^/]+$/.test(pathname)) return route(verb, '/tiles/:hash')
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/history$/.test(pathname))
    return route(verb, '/telemetry/tiles/:x/:y/history')
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/[^/]+$/.test(pathname))
    return route(verb, '/telemetry/tiles/:x/:y/:hash')
  if (
    /^\/telemetry\/templates\/[^/]+\/versions\/[^/]+\/tiles\/[^/]+\/[^/]+\/mismatches$/.test(
      pathname,
    )
  )
    return route(
      verb,
      '/telemetry/templates/:templateId/versions/:versionId/tiles/:x/:y/mismatches',
    )
  return route(verb, 'other')
}

const isTileOfferRoute = (state: RequestMetricState): boolean =>
  state.route === 'POST /telemetry/tiles/offers'

const finiteCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const recordMeasuredD1Queries = (count = 1): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) state.d1MeasuredQueries += count
}

const recordD1Rows = (result: D1Result): void => {
  const state = requestMetricStorage.getStore()
  if (state === undefined) return
  state.d1RowsRead += finiteCount(result.meta.rows_read)
  state.d1RowsWritten += finiteCount(result.meta.rows_written)
}

const recordUnmeasuredD1Query = (): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) state.d1UnmeasuredQueries++
}

export const recordCacheOutcome = (outcome: Exclude<CacheOutcome, 'none'>): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) state.cacheOutcome = outcome
}

export const recordTileOfferBatch = (counts: TileOfferCounts): void => {
  const state = requestMetricStorage.getStore()
  if (state === undefined || !isTileOfferRoute(state)) return
  state.tileOfferCounts = counts
  state.tileOfferOutcome =
    counts.accepted > 0
      ? 'accepted'
      : counts.alreadyKnown > 0
        ? 'already-known'
        : counts.rejected > 0
          ? 'rejected'
          : 'accepted'
}

/** Preserve attempted batch size even when offer processing later fails. */
export const recordTileOfferBatchRequested = (requested: number): void => {
  const state = requestMetricStorage.getStore()
  if (state === undefined || !isTileOfferRoute(state)) return
  state.tileOfferCounts = { ...state.tileOfferCounts, requested: finiteCount(requested) }
}

const finalizedTileOfferOutcome = (
  state: RequestMetricState,
  status: number,
): TileOfferBatchOutcome => {
  if (!isTileOfferRoute(state)) return 'none'
  if (status >= 500) return 'failed'
  if (status >= 400) return 'rejected'
  return state.tileOfferOutcome === 'requested' ? 'accepted' : state.tileOfferOutcome
}

const writeRequestMetric = (
  dataset: MetricDataset | undefined,
  state: RequestMetricState,
  status: number,
  durationMs: number,
): void => {
  if (dataset === undefined) return
  const tileOfferOutcome = finalizedTileOfferOutcome(state, status)
  try {
    dataset.writeDataPoint({
      indexes: [state.route],
      // Keep this order in sync with docs/capacity-metrics.md.
      blobs: [
        'v1',
        state.route,
        state.method,
        state.client,
        state.clientVersion,
        state.syncTransport,
        state.reconciliationReason,
        state.cacheOutcome,
        tileOfferOutcome,
        String(status),
      ],
      doubles: [
        1,
        durationMs,
        state.d1RowsRead,
        state.d1RowsWritten,
        state.d1MeasuredQueries,
        state.d1UnmeasuredQueries,
        state.tileOfferCounts.requested,
        state.tileOfferCounts.accepted,
        state.tileOfferCounts.alreadyKnown,
        state.tileOfferCounts.rejected,
      ],
    })
  } catch (error) {
    // Metrics must never turn a successful application request into a failure.
    console.error('request metrics write failed', error)
  }
}

/** Measure one request and preserve its D1 attribution across concurrent async work. */
export const measureRequest = async (
  dataset: MetricDataset | undefined,
  request: Request,
  pathname: string,
  run: () => Promise<Response>,
): Promise<Response> => {
  const client = parseClientMetricsAccept(request.headers.get('accept'))
  const method = normalizeMetricMethod(request.method)
  const deploymentVersion =
    typeof __CAELESTIS_DEPLOYMENT_VERSION__ === 'string'
      ? __CAELESTIS_DEPLOYMENT_VERSION__.slice(0, 12)
      : 'development'
  const userscriptVersion =
    typeof __CAELESTIS_USERSCRIPT_VERSION__ === 'string'
      ? __CAELESTIS_USERSCRIPT_VERSION__
      : '0.5.4'
  const clientVersion =
    (client.client === 'userscript' && client.version === userscriptVersion) ||
    (client.client === 'frontend' && client.version === deploymentVersion)
      ? client.version
      : 'unknown'
  const state: RequestMetricState = {
    route: normalizeMetricRoute(request.method, pathname),
    method,
    client: client.client,
    clientVersion,
    syncTransport: client.transport,
    reconciliationReason: client.reason,
    cacheOutcome: 'none',
    tileOfferOutcome: pathname === '/telemetry/tiles/offers' ? 'requested' : 'none',
    tileOfferCounts: { requested: 0, accepted: 0, alreadyKnown: 0, rejected: 0 },
    d1RowsRead: 0,
    d1RowsWritten: 0,
    d1MeasuredQueries: 0,
    d1UnmeasuredQueries: 0,
  }
  const startedAt = performance.now()
  return requestMetricStorage.run(state, async () => {
    try {
      const response = await run()
      if (state.route === 'GET /manifest' && response.status === 304) {
        state.cacheOutcome = 'not-modified'
      }
      writeRequestMetric(dataset, state, response.status, performance.now() - startedAt)
      return response
    } catch (error) {
      writeRequestMetric(dataset, state, 500, performance.now() - startedAt)
      throw error
    }
  })
}

const instrumentedDatabases = new WeakMap<object, D1Database>()

/**
 * Wrap a D1 binding once and attribute result metadata to the current measured request.
 *
 * D1 exposes exact row counts on `run`, `all`, and each batch result. `raw`, `first`, and `exec`
 * discard that metadata, so those calls are counted explicitly as unmeasured rather than silently
 * reported as zero-row queries. `raw` must retain its native positional row semantics: translating
 * object rows back into arrays corrupts joins that contain duplicate column names.
 */
export const instrumentD1 = (database: D1Database): D1Database => {
  const cached = instrumentedDatabases.get(database as object)
  if (cached !== undefined) return cached

  const originals = new WeakMap<object, D1PreparedStatement>()
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
      first: (...args: [] | [string]) => {
        recordUnmeasuredD1Query()
        return args.length === 0 ? statement.first() : statement.first(args[0])
      },
      run: async <T = Record<string, unknown>>() => {
        recordMeasuredD1Queries()
        const result = await statement.run<T>()
        recordD1Rows(result)
        return result
      },
      all: async <T = Record<string, unknown>>() => {
        recordMeasuredD1Queries()
        const result = await statement.all<T>()
        recordD1Rows(result)
        return result
      },
      raw: (options?: { columnNames?: boolean }) => {
        recordUnmeasuredD1Query()
        return options?.columnNames === true
          ? statement.raw({ columnNames: true })
          : statement.raw()
      },
    } as D1PreparedStatement
    originals.set(wrapped as object, statement)
    return wrapped
  }

  const unwrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    originals.get(statement as object) ?? statement

  const wrapSession = (session: D1DatabaseSession): D1DatabaseSession =>
    ({
      prepare: (query: string) => wrapStatement(session.prepare(query)),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        recordMeasuredD1Queries(statements.length)
        const results = await session.batch<T>(statements.map(unwrap))
        for (const result of results) recordD1Rows(result)
        return results
      },
      getBookmark: () => session.getBookmark(),
    }) as D1DatabaseSession

  const wrapped = {
    prepare: (query: string) => wrapStatement(database.prepare(query)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      recordMeasuredD1Queries(statements.length)
      const results = await database.batch<T>(statements.map(unwrap))
      for (const result of results) recordD1Rows(result)
      return results
    },
    exec: async (query: string) => {
      recordUnmeasuredD1Query()
      return database.exec(query)
    },
    withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) =>
      wrapSession(database.withSession(constraint)),
    dump: () => database.dump(),
  } as D1Database
  instrumentedDatabases.set(database as object, wrapped)
  return wrapped
}
