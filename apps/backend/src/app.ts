import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Ports } from './ports/index.js'

/**
 * The Hono app, deliberately free of any runtime binding.
 *
 * Entry points adapt this app to a runtime; the app itself stays portable and only depends on the
 * use-case-shaped ports.
 *
 * @see https://github.com/mia-riezebos/wplace-template-server/issues/12
 */
export const createApp = (_ports: Ports) => {
  const app = new Hono()

  // The userscript runs on wplace.live and calls this server cross-origin.
  app.use('/*', cors())

  app.get('/health', (c) => c.json({ ok: true }))

  return app
}

export type App = ReturnType<typeof createApp>
