import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { createApp } from './app.js'
import type { Ports } from './ports/index.js'

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
      // Both were reachable only from tests. Without the season, every deployment answered as
      // season 0 — a later-season server served season 0's manifest, which for a fresh one is empty,
      // and `ServerInfo` carries no season for a client to notice. Without openAccess, a server
      // could not be opened at all.
      currentSeason: parseSeason(env.SEASON),
      openAccess: env.OPEN_ACCESS === 'true',
    }).fetch(request)
  },
} satisfies ExportedHandler<Env>
