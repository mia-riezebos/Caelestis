import type { ServerInfo } from '@caelestis/shared'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createManifestRoutes } from './routes/manifest.js'
import { createNodeRoutes } from './routes/nodes.js'
import { createServerAdminRoutes, createServerRoutes } from './routes/server.js'
import { createTelemetryRoutes } from './routes/telemetry.js'
import { createChunkRoutes, createTemplateRoutes, createTileRoutes } from './routes/templates.js'
import { createTokenRoutes } from './routes/tokens.js'
import { type BackendContext, createBackendRuntime } from './runtime/backend-runtime.js'
import { runBackendHttp } from './runtime/hono.js'

/**
 * The Hono app, deliberately free of any runtime binding.
 *
 * Entry points adapt this app to a runtime; the app itself stays portable and only depends on the
 * use-case-shaped ports.
 *
 * @see https://github.com/mia-riezebos/wplace-template-server/issues/12
 */
export interface AppOptions {
  /**
   * The operator's bootstrap credential. Absent means the server has no bootstrap path, which is
   * the right state once a real admin token has been minted.
   */
  readonly bootstrapAdminToken?: string | undefined
  readonly serverId?: string | undefined
  readonly serverName?: string | undefined
  readonly serverDescription?: string | undefined
  readonly openAccess?: boolean | undefined
  readonly currentSeason?: number | undefined
}

export const createApp = (context: BackendContext, options: AppOptions = {}) => {
  const app = new Hono()
  const runtime = createBackendRuntime(context)
  const auth = {
    bootstrapAdminToken: options.bootstrapAdminToken,
    openAccess: options.openAccess,
  }
  // `??` guards `undefined` and nothing else, and every one of these is a wrangler.toml var an
  // operator edits by hand. A non-UUIDv7 id, an empty name or an empty description all passed
  // through and then failed the wire schema — so the deployment's own manifest became undecodable
  // and the operator heard about it from a client, if at all. Refuse at startup instead.
  const configured = <T>(value: T, valid: (value: T) => boolean, name: string): T => {
    if (!valid(value)) throw new Error(`${name} is not valid: ${JSON.stringify(value)}`)
    return value
  }
  const serverBase = {
    id: configured(
      options.serverId ?? '00000000-0000-7000-8000-000000000000',
      (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
      'serverId',
    ),
    name: configured(
      options.serverName ?? 'Template Server',
      (name) => name.length > 0 && name.length <= 256,
      'serverName',
    ),
    auth: options.openAccess === true ? 'none' : 'access_token',
  } as const
  const server: ServerInfo =
    options.serverDescription === undefined
      ? serverBase
      : {
          ...serverBase,
          description: configured(
            options.serverDescription,
            (description) => description.length > 0 && description.length <= 4_096,
            'serverDescription',
          ),
        }
  const currentSeason = options.currentSeason ?? 0

  // The userscript runs on wplace.live and calls this server cross-origin.
  // `ETag` has to be named explicitly. It is not a CORS-safelisted response header, and Hono only
  // emits `Access-Control-Expose-Headers` when `exposeHeaders` is non-empty — so the userscript,
  // which is cross-origin by definition, read `null` from `response.headers.get('etag')` and could
  // never build an `If-None-Match`. The whole 304 path was unreachable for the only client it
  // exists for, which is also what `assembleManifest` goes to the trouble of being deterministic
  // for. `/chunks` was unaffected: it signals with `Cache-Control`, which is safelisted.
  // Every request it makes carries an `Authorization` header, which is not a CORS-simple header, so
  // *each one* is preceded by an `OPTIONS` preflight — and the default `maxAge` is unset, meaning
  // the browser may not reuse the answer at all. That is what fills the log with 204s: one per
  // manifest poll, one per chunk, one per admin action. The answer cannot vary here — the policy is
  // a constant, not derived from the request — so caching it is free. Browsers clamp this hard
  // (Chromium at 2 hours, Safari at 10 minutes), which is why the number is a ceiling to be ignored
  // rather than a promise to be kept.
  app.use('/*', cors({ origin: '*', exposeHeaders: ['ETag'], maxAge: 86_400 }))

  app.get('/health', (c) =>
    runBackendHttp(c, runtime, Effect.succeed({ ok: true }), (health) => c.json(health)),
  )
  app.route('/server', createServerRoutes(runtime, server))
  app.route('/admin/server', createServerAdminRoutes(runtime, auth))
  app.route('/manifest', createManifestRoutes(runtime, auth, { server, currentSeason }))

  app.route('/admin/tokens', createTokenRoutes(runtime, auth))
  app.route('/admin/nodes', createNodeRoutes(runtime, auth))
  app.route('/admin/templates', createTemplateRoutes(runtime, auth))
  app.route('/chunks', createChunkRoutes(runtime, auth))
  app.route('/tiles', createTileRoutes(runtime, auth))
  app.route('/telemetry', createTelemetryRoutes(runtime, auth, { currentSeason }))

  return app
}

export type App = ReturnType<typeof createApp>
