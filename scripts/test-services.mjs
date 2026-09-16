import { spawnSync } from 'node:child_process'

const databases = ['CAELESTIS_TEST_POSTGRES_URL', 'CAELESTIS_TEST_MARIADB_URL']
for (const key of [...databases, 'CAELESTIS_TEST_S3_ENDPOINT']) {
  if (!process.env[key]) throw new Error(`${key} must point to a disposable test service`)
}
const bun = process.argv.includes('--bun')
const run = (name, args, env) => {
  const result = spawnSync('pnpm', ['--filter', `@caelestis/${name}`, ...args], {
    stdio: 'inherit',
    env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
for (const selected of databases) {
  const env = { ...process.env, CAELESTIS_INTEGRATION_DATABASE: '1' }
  for (const key of databases) if (key !== selected) delete env[key]
  run(
    'backend',
    bun
      ? [
          'exec',
          'bun',
          '--bun',
          'node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          'vitest.integration.config.ts',
        ]
      : ['test:integration'],
    env,
  )
}
run(
  'storage',
  bun ? ['exec', 'bun', '--bun', 'node_modules/vitest/vitest.mjs', 'run'] : ['test:s3'],
  process.env,
)
