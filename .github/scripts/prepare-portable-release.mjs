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
    nodeImageTag: `${imageTag}-node`,
    bunImageTag: `${imageTag}-bun`,
    chartVersion: `${backend}+frontend.${frontend}`,
    tag: `server-${imageTag}`,
  }
}

/** Build immutable patch and moving semantic aliases for one runtime variant. */
export const semanticImageTags = (version, suffix = '') => {
  const [major, minor] = version.split('.')
  return {
    immutable: [`${version}${suffix}`],
    moving: [`${major}.${minor}${suffix}`, `${major}${suffix}`, `latest${suffix}`],
  }
}

/** Map every published variant to the same package name in both registries. */
export const portableImages = (identity, githubRepository) => {
  const match = /^([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/.exec(githubRepository)
  if (!match) throw new Error('GITHUB_REPOSITORY must contain an owner and repository')
  const registries = (repository) => ({
    dockerhub: `docker.io/miacx/${repository}`,
    ghcr: `ghcr.io/${match[1].toLowerCase()}/${repository}`,
  })
  return [
    {
      app: 'backend',
      component: 'backend',
      source: 'backend-bun',
      tag: identity.imageTag,
      aliases: semanticImageTags(identity.backend),
    },
    {
      app: 'backend',
      component: 'backend-node',
      source: 'backend',
      tag: identity.nodeImageTag,
      aliases: semanticImageTags(identity.backend, '-node'),
    },
    {
      app: 'backend',
      component: 'backend-bun',
      source: 'backend-bun',
      tag: identity.bunImageTag,
      aliases: semanticImageTags(identity.backend, '-bun'),
    },
    {
      app: 'frontend',
      component: 'frontend',
      source: 'frontend',
      tag: identity.imageTag,
      aliases: semanticImageTags(identity.frontend),
    },
  ].map((image) => ({
    ...image,
    registries: registries(
      `caelestis-${image.component.startsWith('backend') ? 'backend' : 'frontend'}`,
    ),
  }))
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
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This release CLI does not run through Turbo.
  const githubRepository = process.env.GITHUB_REPOSITORY ?? 'mia-cx/Caelestis'
  const images = portableImages(identity, githubRepository)
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
    resolve(values['output-dir'], 'images.json'),
    `${JSON.stringify(images, null, 2)}\n`,
  )
  const backendRepositories = images[0].registries
  const frontendRepositories = images.at(-1).registries
  const tags = (image) => [...image.aliases.immutable, ...image.aliases.moving].join('`, `')
  writeFileSync(
    resolve(values['output-dir'], 'notes.md'),
    `Caelestis server with backend ${identity.backend} and frontend ${identity.frontend}.\n\nThe default Bun backend uses paired tag \`${identity.imageTag}\` and semantic tags \`${tags(images[0])}\`. Explicit Bun tags use \`${identity.bunImageTag}\`, \`${tags(images[2])}\`; Node tags use \`${identity.nodeImageTag}\`, \`${tags(images[1])}\`. The Node frontend uses paired tag \`${identity.imageTag}\` and semantic tags \`${tags(images[3])}\`. Runtime versions are recorded in versions.json and each image's labels.\n\nImages are published to Docker Hub (\`${backendRepositories.dockerhub}\`, \`${frontendRepositories.dockerhub}\`) and GHCR (\`${backendRepositories.ghcr}\`, \`${frontendRepositories.ghcr}\`). Registry-specific digest references are attached as \`*-dockerhub-image.txt\` and \`*-ghcr-image.txt\`.\n\nChart version: \`${identity.chartVersion}\`. The chart defaults to Bun and the separate Node frontend from Docker Hub.\n\nSee [self-hosting instructions](https://github.com/${githubRepository}/blob/${sha}/docs/self-hosting.md) for runtime selection, migrations, and backups.\n`,
  )
  if (values['github-output'])
    appendFileSync(
      values['github-output'],
      Object.entries(identity)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
}
