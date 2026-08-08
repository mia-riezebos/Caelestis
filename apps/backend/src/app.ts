import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Ports } from './ports/index.js'
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
}

export const createApp = (ports: Ports, options: AppOptions = {}) => {
  const app = new Hono()

  // The userscript runs on wplace.live and calls this server cross-origin.
  app.use('/*', cors())

  app.get('/health', (c) => c.json({ ok: true }))

  app.route(
    '/admin/tokens',
    createTokenRoutes({ sql: ports.sql, bootstrapAdminToken: options.bootstrapAdminToken }),
  )

  return app
}

export type App = ReturnType<typeof createApp>
