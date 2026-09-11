import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(new URL('../../apps/backend/package.json', import.meta.url))
const { unstable_readConfig: readConfig } = require('wrangler')

/** Copy deployable code and bindings, replacing every resource identity and production route. */
export async function cloudflareConfigs({
  directory,
  prefix,
  adminToken,
  readToken,
  accountId,
  databaseId = '00000000-0000-0000-0000-000000000000',
}) {
  const backend = readConfig({ config: resolve('apps/backend/wrangler.toml') })
  const frontend = readConfig({ config: resolve('apps/frontend/wrangler.toml') })
  const config = (source, name) => ({
    name,
    main: source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    workers_dev: Boolean(accountId),
    ...(accountId ? { account_id: accountId } : {}),
  })
  const files = {
    backend: `${directory}/backend.json`,
    frontend: `${directory}/frontend.json`,
    gateway: `${directory}/gateway.json`,
  }
  await writeFile(
    files.backend,
    JSON.stringify({
      ...config(backend, `${prefix}-backend`),
      vars: {
        ...backend.vars,
        SERVER_ID: randomUUID().replace(/^(.{14})./, '$17'),
        SERVER_NAME: 'Stack test',
        ADMIN_TOKEN: adminToken,
      },
      migrations: backend.migrations,
      durable_objects: backend.durable_objects,
      d1_databases: [
        {
          binding: 'DB',
          database_name: prefix,
          database_id: databaseId,
          migrations_dir: resolve('apps/backend/migrations'),
        },
      ],
      r2_buckets: [{ binding: 'BLOBS', bucket_name: prefix }],
    }),
    { mode: 0o600 },
  )
  await writeFile(
    files.frontend,
    JSON.stringify({
      ...config(frontend, `${prefix}-frontend`),
      assets: { ...frontend.assets, directory: resolve('apps/frontend/.svelte-kit/cloudflare') },
      services: [{ binding: 'CAELESTIS_BACKEND', service: `${prefix}-backend` }],
      r2_buckets: [{ binding: 'SOCIAL_IMAGES', bucket_name: prefix }],
      vars: { CAELESTIS_READ_TOKEN: readToken },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    `${directory}/gateway.mjs`,
    `export default {fetch(request, env) { return (new URL(request.url).pathname.startsWith('/backend/') ? env.BACKEND : env.FRONTEND).fetch(request) }}`,
  )
  await writeFile(
    files.gateway,
    JSON.stringify({
      ...config(backend, `${prefix}-gateway`),
      main: `${directory}/gateway.mjs`,
      services: [
        { binding: 'BACKEND', service: `${prefix}-backend` },
        { binding: 'FRONTEND', service: `${prefix}-frontend` },
      ],
    }),
  )
  return files
}
