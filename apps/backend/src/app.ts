import type { ServerInfo } from '@wts/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Ports } from './ports/index.js'
import { createManifestRoutes } from './routes/manifest.js'
import { createNodeRoutes } from './routes/nodes.js'
import { createServerRoutes } from './routes/server.js'
import { createChunkRoutes, createTemplateRoutes } from './routes/templates.js'
import { createTokenRoutes } from './routes/tokens.js'

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

export const createApp = (ports: Ports, options: AppOptions = {}) => {
  const app = new Hono()
  const auth = {
    sql: ports.sql,
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
      options.serverName ?? 'Wplace Template Server',
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

  // The userscript runs on wplace.live and calls this server cross-origin.
  app.use('/*', cors())

  app.get('/health', (c) => c.json({ ok: true }))
  app.route('/server', createServerRoutes(server))
  app.route(
    '/manifest',
    createManifestRoutes(ports, auth, { server, currentSeason: options.currentSeason ?? 1 }),
  )

  app.route('/admin/tokens', createTokenRoutes(auth))
  app.route('/admin/nodes', createNodeRoutes(ports.sql, auth))
  app.route('/admin/templates', createTemplateRoutes(ports, auth))
  app.route('/chunks', createChunkRoutes(ports, auth))

  return app
}

export type App = ReturnType<typeof createApp>
