import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { createApp } from './app.js'
import type { Ports } from './ports/index.js'

export { TelemetryShard } from './telemetry-shard.js'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.SHARD_STRATEGY !== 'single') {
      throw new Error(`Unsupported telemetry shard strategy: ${env.SHARD_STRATEGY}`)
    }

    const ports: Ports = {
      blobs: new R2BlobStore(env.BLOBS),
      sql: new D1SqlStore(env.DB),
      counters: new DurableObjectCounterStore(env.TELEMETRY),
    }

    return createApp(ports, {
      bootstrapAdminToken: env.ADMIN_TOKEN,
      serverId: env.SERVER_ID,
      serverName: env.SERVER_NAME,
      serverDescription: env.SERVER_DESCRIPTION,
    }).fetch(request)
  },
} satisfies ExportedHandler<Env>
