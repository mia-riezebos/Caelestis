import {
  CLIENT_KIND_HEADER,
  CLIENT_KINDS,
  CLIENT_VERSION_HEADER,
  SYNC_MODE_HEADER,
  SYNC_MODES,
  SYNC_REASON_HEADER,
  SYNC_REASONS,
  SYNC_TRANSPORT_HEADER,
  SYNC_TRANSPORTS,
  type SyncMode,
  type SyncReason,
  type SyncTransport,
} from '@caelestis/shared'

const CACHE_OUTCOME_HEADER = 'x-caelestis-cache-outcome'
const CACHE_OUTCOMES = ['none', 'hit', 'miss', 'revalidated', 'bypass', 'stale'] as const
type CacheOutcome = (typeof CACHE_OUTCOMES)[number]

const boundedMember = <Value extends string>(
  value: string | null,
  allowed: readonly Value[],
  fallback: Value,
): Value =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as Value) : fallback

const clientVersion = (request: Request): string => {
  const value = request.headers.get(CLIENT_VERSION_HEADER)
  return value !== null && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(value) ? value : 'unknown'
}

/** Low-cardinality route names; parameters, query strings, hashes, and identifiers never enter logs. */
export const syncRoute = (request: Request): string => {
  const path = new URL(request.url).pathname
  if (path === '/health') return 'health'
  if (path === '/server') return 'server'
  if (path === '/manifest') return 'manifest'
  if (path === '/telemetry/status') return 'status'
  if (path === '/telemetry/tiles/offers') return 'tile-offer'
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/history$/.test(path)) return 'tile-history'
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/[^/]+$/.test(path)) return 'tile-upload'
  if (path === '/telemetry/paints') return 'paint-report'
  if (path === '/telemetry/history') return 'history'
  if (path === '/telemetry/contributions') return 'contributions'
  if (path === '/telemetry/leaderboard') return 'leaderboard'
  if (path === '/telemetry/canvas') return 'canvas'
  if (/^\/admin\/tokens(?:\/[^/]+)?$/.test(path)) return 'token-admin'
  if (/^\/admin\/nodes(?:\/[^/]+(?:\/subtree)?)?$/.test(path)) return 'node-admin'
  if (/^\/admin\/templates(?:\/[^/]+(?:\/versions)?)?$/.test(path)) return 'template-admin'
  if (path === '/admin/server') return 'server-admin'
  if (/^\/chunks\/[^/]+$/.test(path)) return 'chunk'
  if (/^\/tiles\/[^/]+$/.test(path)) return 'canvas-tile'
  return 'other'
}

export interface TileOfferBatchMetrics {
  readonly requested: number
  readonly accepted: number
  readonly alreadyKnown: number
  readonly rejected: number
}

class D1QueryMetrics {
  private queries = 0
  private exactRowsRead = 0
  private lowerBoundRowsRead = 0
  private rowsWritten = 0

  recordResult(result: D1Result<unknown>): void {
    this.queries++
    this.exactRowsRead += this.nonnegativeCount(result.meta.rows_read)
    this.rowsWritten += this.nonnegativeCount(result.meta.rows_written)
  }

  recordRowsWithoutMeta(rows: number): void {
    this.queries++
    this.lowerBoundRowsRead += rows
  }

  private nonnegativeCount(value: unknown): number {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
  }

  snapshot() {
    return {
      queries: this.queries,
      rows_read: this.exactRowsRead + this.lowerBoundRowsRead,
      rows_read_exact: this.exactRowsRead,
      rows_read_lower_bound: this.lowerBoundRowsRead,
      rows_written: this.rowsWritten,
    }
  }
}

export class SyncRequestMetrics {
  readonly d1 = new D1QueryMetrics()
  private readonly startedAt = performance.now()
  private readonly route: string
  private readonly method: string
  private readonly client: string
  private readonly version: string
  private readonly transport: SyncTransport
  private readonly mode: SyncMode
  private readonly reason: SyncReason
  private tileOffer: TileOfferBatchMetrics | undefined

  constructor(request: Request) {
    this.route = syncRoute(request)
    this.method = request.method
    this.client = boundedMember(request.headers.get(CLIENT_KIND_HEADER), CLIENT_KINDS, 'unknown')
    this.version = clientVersion(request)
    this.transport = boundedMember(
      request.headers.get(SYNC_TRANSPORT_HEADER),
      SYNC_TRANSPORTS,
      'http',
    )
    this.mode = boundedMember(request.headers.get(SYNC_MODE_HEADER), SYNC_MODES, 'none')
    this.reason = boundedMember(request.headers.get(SYNC_REASON_HEADER), SYNC_REASONS, 'none')
  }

  recordTileOffer(outcome: TileOfferBatchMetrics): void {
    this.tileOffer = outcome
  }

  finish(response: Response): void {
    const cache = boundedMember(
      response.headers.get(CACHE_OUTCOME_HEADER),
      CACHE_OUTCOMES,
      'none',
    ) as CacheOutcome
    const tileOffer =
      this.route !== 'tile-offer'
        ? undefined
        : {
            requested: this.tileOffer?.requested ?? 0,
            accepted: this.tileOffer?.accepted ?? 0,
            already_known: this.tileOffer?.alreadyKnown ?? 0,
            rejected: this.tileOffer?.rejected ?? 0,
            rejected_batches: response.status >= 400 && response.status < 500 ? 1 : 0,
            failed_batches: response.status >= 500 ? 1 : 0,
          }
    console.log({
      event: 'caelestis.sync.request',
      schema: 1,
      route: this.route,
      method: this.method,
      status: response.status,
      client: this.client,
      client_version: this.version,
      sync_transport: this.transport,
      sync_mode: this.mode,
      sync_reason: this.reason,
      cache_outcome: cache,
      duration_ms: Math.round((performance.now() - this.startedAt) * 100) / 100,
      d1: this.d1.snapshot(),
      ...(tileOffer === undefined ? {} : { tile_offer: tileOffer }),
    })
  }
}

class MeteredD1PreparedStatement implements D1PreparedStatement {
  constructor(
    readonly source: D1PreparedStatement,
    private readonly metrics: D1QueryMetrics,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new MeteredD1PreparedStatement(this.source.bind(...values), this.metrics)
  }

  first<T = unknown>(colName?: string): Promise<T | null> {
    const read = colName === undefined ? this.source.first<T>() : this.source.first<T>(colName)
    return read.then((result) => {
      this.metrics.recordRowsWithoutMeta(result === null ? 0 : 1)
      return result
    })
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.source.run<T>().then((result) => {
      this.metrics.recordResult(result)
      return result
    })
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.source.all<T>().then((result) => {
      this.metrics.recordResult(result)
      return result
    })
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    if (options?.columnNames === true) {
      return this.source.raw<T>({ columnNames: true }).then((rows) => {
        this.metrics.recordRowsWithoutMeta(Math.max(0, rows.length - 1))
        return rows
      })
    }
    return this.source.raw<T>({ columnNames: false }).then((rows) => {
      this.metrics.recordRowsWithoutMeta(rows.length)
      return rows
    })
  }
}

const unwrapStatements = (statements: D1PreparedStatement[]): D1PreparedStatement[] =>
  statements.map((statement) =>
    statement instanceof MeteredD1PreparedStatement ? statement.source : statement,
  )

class MeteredD1DatabaseSession implements D1DatabaseSession {
  constructor(
    private readonly source: D1DatabaseSession,
    private readonly metrics: D1QueryMetrics,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new MeteredD1PreparedStatement(this.source.prepare(query), this.metrics)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.source.batch<T>(unwrapStatements(statements)).then((results) => {
      for (const result of results) this.metrics.recordResult(result)
      return results
    })
  }

  getBookmark(): D1SessionBookmark | null {
    return this.source.getBookmark()
  }
}

class MeteredD1Database implements D1Database {
  constructor(
    private readonly source: D1Database,
    private readonly metrics: D1QueryMetrics,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new MeteredD1PreparedStatement(this.source.prepare(query), this.metrics)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.source.batch<T>(unwrapStatements(statements)).then((results) => {
      for (const result of results) this.metrics.recordResult(result)
      return results
    })
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.source.exec(query)
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return new MeteredD1DatabaseSession(this.source.withSession(constraintOrBookmark), this.metrics)
  }

  dump(): Promise<ArrayBuffer> {
    return this.source.dump()
  }
}

/** Capture exact D1 metadata where available and returned-row lower bounds for Drizzle raw reads. */
export const meterD1Database = (database: D1Database, metrics: SyncRequestMetrics): D1Database =>
  new MeteredD1Database(database, metrics.d1)
