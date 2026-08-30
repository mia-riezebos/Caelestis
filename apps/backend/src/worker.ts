import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { type App, createApp } from './app.js'
import { instrumentD1, measureRequest } from './metrics/request-metrics.js'
import { makeBackendContext } from './runtime/backend-runtime.js'
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

/** One prepared Hono/Effect runtime per Worker environment object, released with that environment. */
const preparedApps = new WeakMap<Env, App>()

const appFor = (env: Env): App => {
  const prepared = preparedApps.get(env)
  if (prepared !== undefined) return prepared

  const context = makeBackendContext(
    new R2BlobStore(env.BLOBS),
    new D1SqlStore(instrumentD1(env.DB)),
    new DurableObjectCounterStore(env.TELEMETRY),
  )
  const app = createApp(context, {
    bootstrapAdminToken: env.ADMIN_TOKEN,
    serverId: env.SERVER_ID,
    serverName: env.SERVER_NAME,
    serverDescription: env.SERVER_DESCRIPTION,
    // Without the season, every deployment answers as season 0. Without openAccess, a server that
    // advertises anonymous reads still rejects its manifest. Keep both in the prepared app config.
    currentSeason: parseSeason(env.SEASON),
    openAccess: env.OPEN_ACCESS === 'true',
  })
  preparedApps.set(env, app)
  return app
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.SHARD_STRATEGY !== 'single') {
      throw new Error(`Unsupported telemetry shard strategy: ${env.SHARD_STRATEGY}`)
    }

    const mountedRequest = requestAtBasePath(request, env.BASE_PATH)
    if (mountedRequest === null) {
      return measureRequest(
        env.REQUEST_METRICS,
        request,
        'other',
        async () => new Response('Not Found', { status: 404 }),
      )
    }

    return measureRequest(
      env.REQUEST_METRICS,
      mountedRequest,
      new URL(mountedRequest.url).pathname,
      async () => appFor(env).fetch(mountedRequest),
    )
  },

  // The 6-hour tile mirror — see [triggers] in wrangler.toml and telemetry/fetcher.ts.
  async scheduled(_controller, env, ctx): Promise<void> {
    const stores = {
      blobs: new R2BlobStore(env.BLOBS),
      sql: new D1SqlStore(instrumentD1(env.DB)),
      counters: new DurableObjectCounterStore(env.TELEMETRY),
    }
    const gcMode = tileBlobGcMode(env.TILE_BLOB_GC_MODE)
    ctx.waitUntil(
      fetchCanvasTiles(stores, { season: parseSeason(env.SEASON) ?? 0 }).finally(async () => {
        // A prior template may already have persisted a probe when later scan work fails. Always
        // reconcile the watcher so that durable work cannot be stranded until the next cron.
        await env.ALARM_WATCHER.getByName('global').schedule()
      }),
    )
    ctx.waitUntil(runTileBlobGc(stores, { mode: gcMode }).then(() => undefined))
  },
} satisfies ExportedHandler<Env>
