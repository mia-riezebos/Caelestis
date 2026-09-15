import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const run = async (command, args, options = {}) =>
  (await execFile(command, args, options)).stdout.trim()
const identity = `${process.pid}-${Date.now().toString(36)}`
const password = 'caelestis-test'

const waitFor = async (name, command) => {
  const deadline = Date.now() + 60_000
  let failure
  while (Date.now() < deadline) {
    try {
      await run('docker', ['exec', name, ...command])
      return
    } catch (error) {
      failure = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`Timed out waiting for ${name}: ${String(failure)}`)
}

const hostPort = async (name, port) => {
  const mapping = await run('docker', ['port', name, port])
  const match = mapping.match(/127\.0\.0\.1:(\d+)/)
  if (!match) throw new Error(`Docker did not report an IPv4 port for ${name}: ${mapping}`)
  return match[1]
}

const test = (environment, bun = false) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      bun ? 'bun' : 'pnpm',
      bun
        ? [
            '--bun',
            'node_modules/vitest/vitest.mjs',
            'run',
            '--config',
            'vitest.integration.config.ts',
          ]
        : ['test:integration'],
      {
        stdio: 'inherit',
        env: { ...process.env, ...environment },
      },
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`integration tests exited ${code}`)),
    )
  })

const containers = []
const start = async (name, args) => {
  await run('docker', ['run', '--rm', '-d', '--name', name, ...args])
  containers.push(name)
}
const cleanup = async () => {
  await Promise.all(
    containers.reverse().map((name) => run('docker', ['rm', '-f', name]).catch(() => undefined)),
  )
}
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => void cleanup().finally(() => process.exit(exitCode)))
}

try {
  const postgres = `caelestis-test-postgres-${identity}`
  const postgresDatabase = `caelestis_${identity.replace('-', '_')}`
  await start(postgres, [
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${postgresDatabase}`,
    'postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675',
  ])
  await waitFor(postgres, ['pg_isready', '-U', 'postgres', '-d', postgresDatabase])
  const postgresEnvironment = {
    CAELESTIS_INTEGRATION_DATABASE: '1',
    CAELESTIS_TEST_POSTGRES_URL: `postgresql://postgres:${password}@127.0.0.1:${await hostPort(postgres, '5432/tcp')}/${postgresDatabase}`,
    CAELESTIS_TEST_MARIADB_URL: undefined,
  }
  await test(postgresEnvironment)
  await test(postgresEnvironment, true)

  const mariadb = `caelestis-test-mariadb-${identity}`
  const mariaDatabase = `caelestis_${identity.replace('-', '_')}`
  await start(mariadb, [
    '-p',
    '127.0.0.1::3306',
    '-e',
    `MARIADB_ROOT_PASSWORD=${password}`,
    '-e',
    'MARIADB_ROOT_HOST=%',
    '-e',
    `MARIADB_DATABASE=${mariaDatabase}`,
    'mariadb:11.8@sha256:2d2f4095530294735a857cfe22bb101e19b0849b416911c796ec4aa81b164a62',
  ])
  await waitFor(mariadb, ['mariadb', '-uroot', `-p${password}`, '-e', 'SELECT 1'])
  const mariadbEnvironment = {
    CAELESTIS_INTEGRATION_DATABASE: '1',
    CAELESTIS_TEST_POSTGRES_URL: undefined,
    CAELESTIS_TEST_MARIADB_URL: `mariadb://root:${password}@127.0.0.1:${await hostPort(mariadb, '3306/tcp')}/${mariaDatabase}`,
  }
  await test(mariadbEnvironment)
  await test(mariadbEnvironment, true)
} finally {
  await cleanup()
}
