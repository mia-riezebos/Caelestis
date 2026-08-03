import { serve } from '@hono/node-server'
import { createApp } from './app.js'

/**
 * Local development harness only. Running under Node here does not imply Node in production —
 * that decision is still open, and `app.ts` stays portable so either answer remains cheap.
 */
const port = Number(process.env['PORT'] ?? 8787)

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`backend listening on http://localhost:${info.port}`)
})
