import { Hono } from 'hono'
import { cors } from 'hono/cors'

/**
 * The Hono app, deliberately free of any runtime binding.
 *
 * The runtime is still undecided (Cloudflare Workers + R2 + D1 + Durable Objects vs Node/Bun +
 * S3-compatible + Postgres), so nothing here may import a platform SDK. Entry points adapt this
 * app to a runtime; the app itself stays portable.
 *
 * @see https://github.com/mia-riezebos/wplace-template-server/issues/12
 */
export const createApp = () => {
  const app = new Hono()

  // The userscript runs on wplace.live and calls this server cross-origin.
  app.use('/*', cors())

  app.get('/health', (c) => c.json({ ok: true }))

  return app
}

export type App = ReturnType<typeof createApp>
