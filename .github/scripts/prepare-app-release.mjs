import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseNotesFor } from './release-notes.mjs'

const APPS = new Set(['frontend', 'backend'])
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const prepareAppRelease = ({ root, outputDirectory, app }) => {
  if (!APPS.has(app)) throw new Error(`unsupported release app: ${app}`)
  const appDirectory = resolve(root, 'apps', app)
  const packageJson = JSON.parse(readFileSync(resolve(appDirectory, 'package.json'), 'utf8'))
  const version = packageJson.version
  if (typeof version !== 'string' || !VERSION.test(version) || version === '0.0.0') {
    throw new Error(`${app} package has no releasable version: ${String(version)}`)
  }

  const changelog = readFileSync(resolve(appDirectory, 'CHANGELOG.md'), 'utf8')
  const notes = releaseNotesFor(changelog, version)
  mkdirSync(outputDirectory, { recursive: true })
  const notesPath = resolve(outputDirectory, 'release-notes.md')
  writeFileSync(notesPath, `${notes}\n`)

  return { app, version, tag: `${app}-v${version}`, notesPath }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argument = (name) => {
    const index = process.argv.indexOf(name)
    if (index === -1) return undefined
    const value = process.argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  const root = resolve(process.cwd())
  const app = argument('--app')
  const outputDirectory = argument('--output-dir')
  const githubOutput = argument('--github-output')
  if (app === undefined || outputDirectory === undefined) {
    throw new Error('--app and --output-dir are required')
  }
  const release = prepareAppRelease({ root, outputDirectory: resolve(outputDirectory), app })
  if (githubOutput !== undefined) {
    appendFileSync(
      githubOutput,
      `${Object.entries(release)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    )
  }
  process.stdout.write(`${JSON.stringify(release)}\n`)
}
