import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const [backend, frontend] = process.argv.slice(2)
if (!backend || !frontend)
  throw new Error('Usage: node scripts/test-portable-compose.mjs BACKEND_IMAGE FRONTEND_IMAGE')
for (const database of ['sqlite', 'postgres', 'mariadb']) {
  for (const storage of ['filesystem', 's3']) {
    const project = `caelestis-compose-${process.pid}-${database}-${storage}`
    const files = ['-f', 'compose.yaml']
    if (database !== 'sqlite') files.push('-f', `deploy/compose/${database}.yaml`)
    if (storage === 's3') files.push('-f', 'deploy/compose/s3.yaml')
    const env = {
      ...process.env,
      ADMIN_TOKEN: 'compose-admin-test',
      CAELESTIS_READ_TOKEN: 'compose-read-test',
      POSTGRES_PASSWORD: 'compose-postgres-test',
      MARIADB_PASSWORD: 'compose-maria-test',
      MINIO_ROOT_PASSWORD: 'compose-minio-test',
      CAELESTIS_ENV_FILE: '.env.example',
      CAELESTIS_BACKEND_IMAGE: backend,
      CAELESTIS_FRONTEND_IMAGE: frontend,
      CAELESTIS_HTTP_PORT: '0',
      CAELESTIS_BIND_ADDRESS: '127.0.0.1',
    }
    const compose = (...args) =>
      execFileSync(
        'docker',
        ['compose', '--env-file', '.env.example', '-p', project, ...files, ...args],
        { env, encoding: 'utf8' },
      ).trim()
    try {
      compose('config', '--quiet')
      compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120')
      const address = compose('port', 'frontend', '3000')
      assert.equal((await fetch(`http://${address}/`)).status, 200)
      const manifest = await (await fetch(`http://${address}/api/v1/manifest`)).json()
      assert.equal(manifest.server.liveSyncMax, 2)
      const variables = JSON.parse(
        execFileSync(
          'docker',
          ['inspect', '--format', '{{json .Config.Env}}', compose('ps', '-q', 'frontend')],
          { encoding: 'utf8' },
        ),
      )
      assert.ok(
        !variables.some((value) => /^(ADMIN_TOKEN|PGPASSWORD|MARIADB_PASSWORD)=/.test(value)),
      )
      console.log(`${database}/${storage}: Compose startup and frontend read passed`)
    } catch (error) {
      console.error(compose('logs', '--no-color', '--tail', '80'))
      throw error
    } finally {
      compose('down', '--volumes', '--remove-orphans')
    }
  }
}
