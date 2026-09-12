import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { acceptance, waitFor } from './stack-tests/acceptance.mjs'
import { cloudflareConfigs } from './stack-tests/cloudflare-config.mjs'
import { availablePort, run, start } from './stack-tests/process.mjs'

const wrangler = resolve('apps/backend/node_modules/.bin/wrangler')
const directory = await mkdtemp(`${tmpdir()}/caelestis-workerd-`)
const log = resolve('test-results/cloudflare-local/workers.log')
await rm(resolve('test-results/cloudflare-local'), { recursive: true, force: true })
const prefix = `caelestis-ci-${randomUUID().slice(0, 8)}`
const adminToken = randomUUID()
const readToken = randomUUID()
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
delete env.CLOUDFLARE_API_TOKEN
delete env.CLOUDFLARE_ACCOUNT_ID
const persist = `${directory}/state`
let server
try {
  const {
    backend: backendConfig,
    frontend: frontendConfig,
    gateway: gatewayConfig,
  } = await cloudflareConfigs({ directory, prefix, adminToken, readToken })
  const command = (...args) => run(wrangler, args, { env, log })
  await command(
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    backendConfig,
    '--persist-to',
    persist,
  )
  const hash = createHash('sha256').update(readToken).digest('hex')
  await command(
    'd1',
    'execute',
    'DB',
    '--local',
    '--config',
    backendConfig,
    '--persist-to',
    persist,
    '--command',
    `INSERT INTO access_tokens VALUES ('${hash}', 'frontend', 'read', 'bootstrap', 0)`,
  )
  const port = await availablePort()
  const site = `http://127.0.0.1:${port}`
  const launch = async () => {
    server = start(
      wrangler,
      [
        'dev',
        '--local',
        '--config',
        gatewayConfig,
        '--config',
        frontendConfig,
        '--config',
        backendConfig,
        '--persist-to',
        persist,
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        '0',
      ],
      { env, log },
    )
    await waitFor(
      async () =>
        (await fetch(`${site}/api/v1/manifest`, { signal: AbortSignal.timeout(3000) })).ok,
      'local Workers',
    )
  }
  await launch()
  const suite = acceptance({ site, adminToken, readToken })
  const state = await suite.seed()
  await suite.verify(state)
  await server.stop()
  await launch()
  await suite.verify(state)
  await suite.remove(state)
  await writeFile(
    resolve('test-results/cloudflare-local/result.json'),
    JSON.stringify({ passed: true }),
  )
  console.log('Cloudflare: frontend, D1, R2, Durable Objects, WebSockets and restart passed')
} finally {
  await server?.stop()
  await rm(directory, { recursive: true, force: true })
}
