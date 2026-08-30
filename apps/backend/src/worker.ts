import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { type App, createApp } from './app.js'
import {
  type BackendRuntime,
  createBackendRuntime,
  makeBackendContext,
} from './runtime/backend-runtime.js'
import { fetchCanvasTiles } from './telemetry/fetcher.js'
import { runTileBlobGc, type TileBlobGcMode } from './telemetry/tile-blobs.js'

export { AlarmWatcher } from './alarm-watcher.js'
export { TelemetryShard } from './telemetry-shard.js'

/**
 * `SEASON` as a season number, or a refusal.
 *
 * `Number('abc')` is NaN and `Number('-1')` is -1, and either reached `/manifest` as the season it
 * reports — NaN serializes to `null`, which the wire refuses outright, so the deployment's own
 * manifest stopped decoding because of a typo in a config var.
 */
const parseSeason = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`SEASON is not a season number: ${JSON.stringify(value)}`)
  }
  const season = Number(value)
  if (!Number.isSafeInteger(season) || season < 0) {
    throw new Error(`SEASON is not a season number: ${JSON.stringify(value)}`)
  }
  return season
}

const requestAtBasePath = (request: Request, configured: string | undefined): Request | null => {
  if (configured === undefined || configured === '' || configured === '/') return request
  if (!configured.startsWith('/') || configured.endsWith('/') || /[?#]/.test(configured)) {
    throw new Error(
      `BASE_PATH is not an absolute path without a trailing slash: ${JSON.stringify(configured)}`,
    )
  }
  const url = new URL(request.url)
  if (url.pathname !== configured && !url.pathname.startsWith(`${configured}/`)) return null
  url.pathname = url.pathname.slice(configured.length) || '/'
  return new Request(url, request)
}

const tileBlobGcMode = (value: string | undefined): TileBlobGcMode => {
  if (value === undefined || value === 'dry-run') return 'dry-run'
  if (value === 'delete') return 'delete'
  throw new Error(`Unsupported TILE_BLOB_GC_MODE: ${JSON.stringify(value)}`)
}

export interface PreparedBackend {
  readonly app: App
  readonly runtime: BackendRuntime
  readonly season: number
  readonly stores: {
    readonly blobs: R2BlobStore
    readonly sql: D1SqlStore
  }
}

/** Prepare binding-derived adapters and their Effect Context for the current Worker event. */
export const prepareBackendForEvent = (env: Env): PreparedBackend => {
  if (env.SHARD_STRATEGY !== 'single') {
    throw new Error(`Unsupported telemetry shard strategy: ${env.SHARD_STRATEGY}`)
  }
  const season = parseSeason(env.SEASON) ?? 0
  const blobs = new R2BlobStore(env.BLOBS)
  const sql = new D1SqlStore(env.DB)
  const counters = new DurableObjectCounterStore(env.TELEMETRY)
  const runtime = createBackendRuntime(
    makeBackendContext(blobs, sql, counters, {
      bootstrapAdminToken: env.ADMIN_TOKEN,
      openAccess: env.OPEN_ACCESS === 'true',
    }),
  )
  const app = createApp(runtime, {
    serverId: env.SERVER_ID,
    serverName: env.SERVER_NAME,
    serverDescription: env.SERVER_DESCRIPTION,
    currentSeason: season,
    openAccess: env.OPEN_ACCESS === 'true',
  })
  return {
    app,
    runtime,
    season,
    stores: { blobs, sql },
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mountedRequest = requestAtBasePath(request, env.BASE_PATH)
    if (mountedRequest === null) return new Response('Not Found', { status: 404 })
    return prepareBackendForEvent(env).app.fetch(mountedRequest)
  },

  // The 6-hour tile mirror — see [triggers] in wrangler.toml and telemetry/fetcher.ts.
  async scheduled(_controller, env, ctx): Promise<void> {
    const prepared = prepareBackendForEvent(env)
    const gcMode = tileBlobGcMode(env.TILE_BLOB_GC_MODE)
    ctx.waitUntil(
      prepared.runtime.run(fetchCanvasTiles({ season: prepared.season })).finally(async () => {
        // A prior template may already have persisted a probe when later scan work fails. Always
        // reconcile the watcher so durable work cannot be stranded until the next cron.
        await env.ALARM_WATCHER.getByName('global').schedule()
      }),
    )
    ctx.waitUntil(runTileBlobGc(prepared.stores, { mode: gcMode }).then(() => undefined))
  },
} satisfies ExportedHandler<Env>
