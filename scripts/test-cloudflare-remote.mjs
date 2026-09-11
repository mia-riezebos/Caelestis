import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { acceptance, waitFor } from './stack-tests/acceptance.mjs'
import { cloudflareConfigs } from './stack-tests/cloudflare-config.mjs'
import { run } from './stack-tests/process.mjs'

// Reserved exclusively for this suite. The workflow serializes all remote runs.
const prefix = 'caelestis-stack-ci'
const accountId = process.env.CLOUDFLARE_TEST_ACCOUNT_ID
const token = process.env.CLOUDFLARE_TEST_API_TOKEN
assert.match(
  accountId ?? '',
  /^[a-f0-9]{32}$/,
  'Set CLOUDFLARE_TEST_ACCOUNT_ID; see docs/stack-testing.md',
)
assert.ok(token, 'Set CLOUDFLARE_TEST_API_TOKEN; see docs/stack-testing.md')
const directory = await mkdtemp(`${tmpdir()}/caelestis-cloud-ci-`)
const output = resolve('test-results/cloudflare-remote')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const log = `${output}/deploy.log`
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: token,
  WRANGLER_SEND_METRICS: 'false',
}
const wrangler = resolve('apps/backend/node_modules/.bin/wrangler')
const command = (...args) => run(wrangler, args, { env, log })
const api = async (path, method = 'GET', body) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  )
  if (response.status === 404) return null
  const result = await response.json()
  assert.ok(response.ok && result.success, `${method} ${path}: ${JSON.stringify(result.errors)}`)
  return result.result
}
const { subdomain } = await api('/workers/subdomain')
assert.match(subdomain, /^[a-z0-9-]+$/, 'Enable a workers.dev subdomain; see docs/stack-testing.md')
const site = `https://${prefix}-gateway.${subdomain}.workers.dev`

// Recreate the cleaner with a fresh credential so interrupted runs never need manual recovery.
const cleanup = async () => {
  const errors = []
  const attempt = async (operation) => {
    try {
      await operation()
    } catch (error) {
      errors.push(error)
    }
  }
  if (await api(`/r2/buckets/${prefix}`)) {
    await attempt(async () => {
      const cleanupToken = randomUUID()
      await writeFile(
        `${directory}/cleaner.mjs`,
        `export default {async fetch(request, env) {
        if(request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer '+env.TOKEN) return new Response(null,{status:403});
        for(;;) { const page=await env.BUCKET.list({limit:1000}); if(!page.objects.length) break; await env.BUCKET.delete(page.objects.map(o=>o.key)); }
        return new Response('empty');
      }}`,
      )
      await writeFile(
        `${directory}/cleaner.json`,
        JSON.stringify({
          name: `${prefix}-cleaner`,
          account_id: accountId,
          main: `${directory}/cleaner.mjs`,
          compatibility_date: '2026-08-03',
          workers_dev: true,
          r2_buckets: [{ binding: 'BUCKET', bucket_name: prefix }],
          vars: { TOKEN: cleanupToken },
        }),
        { mode: 0o600 },
      )
      await command('deploy', '--config', `${directory}/cleaner.json`)
      await waitFor(
        async () =>
          (
            await fetch(`https://${prefix}-cleaner.${subdomain}.workers.dev`, {
              method: 'POST',
              headers: { authorization: `Bearer ${cleanupToken}` },
              signal: AbortSignal.timeout(30_000),
            })
          ).ok,
        'test bucket cleanup',
        120_000,
      )
    })
  }
  for (const component of ['gateway', 'frontend', 'backend', 'cleaner'])
    await attempt(() => api(`/workers/scripts/${prefix}-${component}?force=true`, 'DELETE'))
  await attempt(async () => {
    const databases = await api(`/d1/database?name=${prefix}`)
    for (const database of databases ?? []) {
      if (database.name !== prefix) continue
      await api(`/d1/database/${database.uuid}`, 'DELETE')
    }
  })
  await attempt(() => api(`/r2/buckets/${prefix}`, 'DELETE'))
  if (errors.length)
    throw new AggregateError(
      errors,
      'Test resource cleanup failed; the next run retries cleanup before provisioning',
    )
}
try {
  await cleanup()
  const database = await api('/d1/database', 'POST', { name: prefix })
  await api('/r2/buckets', 'POST', { name: prefix })
  const adminToken = randomUUID()
  const readToken = randomUUID()
  const configs = await cloudflareConfigs({
    directory,
    prefix,
    adminToken,
    readToken,
    accountId,
    databaseId: database.uuid,
  })
  await command('d1', 'migrations', 'apply', 'DB', '--remote', '--config', configs.backend)
  const hash = createHash('sha256').update(readToken).digest('hex')
  await command(
    'd1',
    'execute',
    'DB',
    '--remote',
    '--config',
    configs.backend,
    '--command',
    `INSERT INTO access_tokens VALUES ('${hash}', 'frontend', 'read', 'bootstrap', 0)`,
  )
  for (const component of ['backend', 'frontend', 'gateway'])
    await command('deploy', '--config', configs[component])
  await waitFor(
    async () =>
      (await fetch(`${site}/api/v1/manifest`, { signal: AbortSignal.timeout(10_000) })).ok,
    'remote Workers',
    180_000,
  )
  const suite = acceptance({ site, adminToken, readToken })
  const state = await suite.seed()
  await suite.verify(state)
  // Redeploy the exact Worker to test Durable Object state across deployment replacement.
  await command('deploy', '--config', configs.backend)
  await suite.verify(state)
  await suite.remove(state)
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true }))
  console.log('Dedicated Cloudflare deployment passed')
} finally {
  try {
    await cleanup()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
