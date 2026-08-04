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
  const auth = { sql: ports.sql, bootstrapAdminToken: options.bootstrapAdminToken }
  const serverBase = {
    id: options.serverId ?? '00000000-0000-7000-8000-000000000000',
    name: options.serverName ?? 'Wplace Template Server',
    auth: options.openAccess === true ? 'none' : 'access_token',
  } as const
  const server: ServerInfo =
    options.serverDescription === undefined
      ? serverBase
      : { ...serverBase, description: options.serverDescription }

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
