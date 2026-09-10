import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Map both app versions to immutable image and chart versions. */
export const portableVersion = (backend, frontend) => {
  for (const version of [backend, frontend]) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
      throw new Error('Portable releases require stable app versions')
  }
  const imageTag = `backend-${backend}-frontend-${frontend}`
  return {
    backend,
    frontend,
    imageTag,
    chartVersion: `${backend}+frontend.${frontend}`,
    tag: `server-${imageTag}`,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({
    options: { 'output-dir': { type: 'string' }, 'github-output': { type: 'string' } },
  })
  if (!values['output-dir']) throw new Error('--output-dir is required')
  const root = resolve(import.meta.dirname, '../..')
  const version = (app) =>
    JSON.parse(readFileSync(resolve(root, `apps/${app}/package.json`), 'utf8')).version
  const identity = portableVersion(version('backend'), version('frontend'))
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This release CLI does not run through Turbo.
  const sha = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('GITHUB_SHA must identify the release commit')
  mkdirSync(values['output-dir'], { recursive: true })
  const migrations = (directory) =>
    readdirSync(resolve(root, directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => ({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(resolve(root, directory, name)))
          .digest('hex'),
      }))
  writeFileSync(
    resolve(values['output-dir'], 'versions.json'),
    `${JSON.stringify({ ...identity, commit: sha, postgresMigrations: migrations('apps/backend/migrations-postgres'), mariaMigrations: migrations('apps/backend/migrations-mariadb'), sqliteMigrations: migrations('apps/backend/migrations'), runtimeSchema: 1 }, null, 2)}\n`,
  )
  writeFileSync(
    resolve(values['output-dir'], 'notes.md'),
    `Caelestis server with backend ${identity.backend} and frontend ${identity.frontend}.\n\nImage tag: \`${identity.imageTag}\`. Chart version: \`${identity.chartVersion}\`.\n\nSee [self-hosting instructions](https://github.com/mia-riezebos/Caelestis/blob/${sha}/docs/self-hosting.md) for configuration, migrations, and backups.\n`,
  )
  if (values['github-output'])
    appendFileSync(
      values['github-output'],
      Object.entries(identity)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
}
