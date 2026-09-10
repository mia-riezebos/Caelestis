import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PoolConfig } from 'pg'

type Environment = Readonly<Record<string, string | undefined>>
const integer = (env: Environment, name: string, fallback: number): number => {
  const value = env[name]
  if (value === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a non-negative integer`)
  return Number(value)
}
const boolean = (env: Environment, name: string): boolean => {
  if (env[name] === undefined || env[name] === 'false') return false
  if (env[name] === 'true') return true
  throw new Error(`${name} must be true or false`)
}

/** Validate the portable deployment configuration before opening storage or accepting traffic. */
export const readNodeConfig = (env: Environment = process.env) => {
  if (integer(env, 'REPLICAS', 1) !== 1)
    throw new Error('Only one active application replica is supported')
  if (env.SHARD_STRATEGY !== undefined && env.SHARD_STRATEGY !== 'single')
    throw new Error('Only SHARD_STRATEGY=single is supported')
  const adapter = env.DB_ADAPTER ?? 'sqlite'
  if (adapter !== 'sqlite' && adapter !== 'postgres')
    throw new Error(`Unsupported DB_ADAPTER: ${adapter}`)
  const port = integer(env, 'PORT', 3000)
  if (port > 65535) throw new Error('PORT must be at most 65535')
  const basePath = env.BASE_PATH ?? '/backend'
  if (
    !basePath.startsWith('/') ||
    basePath === '/' ||
    basePath.endsWith('/') ||
    /[?#]/.test(basePath)
  )
    throw new Error('BASE_PATH must be an absolute non-root path without a trailing slash')
  const tlsMode = env.PG_TLS_MODE ?? 'verify-full'
  if (!['verify-full', 'require', 'disable'].includes(tlsMode))
    throw new Error('Unsupported PG_TLS_MODE')
  if (
    env.DATABASE_URL &&
    [...new URL(env.DATABASE_URL).searchParams.keys()].some((key) => key.startsWith('ssl'))
  )
    throw new Error(
      'Configure PostgreSQL TLS through PG_TLS_MODE and PG_TLS_CA_FILE, not DATABASE_URL parameters',
    )
  if (adapter === 'postgres' && !env.DATABASE_URL && !env.PGHOST)
    throw new Error('PostgreSQL requires DATABASE_URL or PGHOST')
  const pg: PoolConfig = {
    ...(env.PGHOST ? { host: env.PGHOST } : {}),
    ...(env.PGPORT ? { port: integer(env, 'PGPORT', 5432) } : {}),
    ...(env.PGDATABASE ? { database: env.PGDATABASE } : {}),
    ...(env.PGUSER ? { user: env.PGUSER } : {}),
    ...(env.PGPASSWORD ? { password: env.PGPASSWORD } : {}),
    ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}),
    ssl:
      tlsMode === 'disable'
        ? false
        : {
            rejectUnauthorized: tlsMode === 'verify-full',
            ...(env.PG_TLS_CA_FILE ? { ca: readFileSync(env.PG_TLS_CA_FILE, 'utf8') } : {}),
            ...(env.PG_TLS_CERT_FILE ? { cert: readFileSync(env.PG_TLS_CERT_FILE, 'utf8') } : {}),
            ...(env.PG_TLS_KEY_FILE ? { key: readFileSync(env.PG_TLS_KEY_FILE, 'utf8') } : {}),
          },
  }
  const tileGc = env.TILE_BLOB_GC_MODE ?? 'dry-run'
  if (tileGc !== 'dry-run' && tileGc !== 'delete') throw new Error('Unsupported TILE_BLOB_GC_MODE')
  return {
    adapter,
    port,
    basePath,
    pg,
    tileGc,
    host: env.HOST ?? '0.0.0.0',
    databaseFile: env.SQLITE_FILE ?? resolve(env.DATA_DIRECTORY ?? './data', 'caelestis.sqlite'),
    season: integer(env, 'SEASON', 0),
    openAccess: boolean(env, 'OPEN_ACCESS'),
    adminToken: env.ADMIN_TOKEN,
    readToken: env.CAELESTIS_READ_TOKEN,
    serverId: env.SERVER_ID,
    serverName: env.SERVER_NAME ?? 'Caelestis',
    serverDescription: env.SERVER_DESCRIPTION,
  } as const
}

export type NodeConfig = ReturnType<typeof readNodeConfig>
