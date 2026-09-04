import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseNotesFor } from './release-notes.mjs'

export { releaseNotesFor } from './release-notes.mjs'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const prepareUserscriptRelease = ({ root, outputDirectory }) => {
  const packageJson = JSON.parse(
    readFileSync(resolve(root, 'apps/userscript/package.json'), 'utf8'),
  )
  const version = packageJson.version
  if (typeof version !== 'string' || !VERSION.test(version) || version === '0.0.0') {
    throw new Error(`userscript package has no releasable version: ${String(version)}`)
  }

  const builtPath = resolve(root, 'apps/userscript/dist/wplace-template-server.user.js')
  const built = readFileSync(builtPath)
  const metadata = built.subarray(0, Math.min(built.length, 2_048)).toString('utf8')
  if (!metadata.includes(`// @version      ${version}\n`)) {
    throw new Error(`built userscript metadata does not contain version ${version}`)
  }

  const changelog = readFileSync(resolve(root, 'apps/userscript/CHANGELOG.md'), 'utf8')
  const notes = releaseNotesFor(changelog, version)
  const tag = `userscript-v${version}`
  const stableName = 'caelestis.user.js'
  const versionedName = `caelestis-v${version}.user.js`
  mkdirSync(outputDirectory, { recursive: true })
  const stablePath = resolve(outputDirectory, stableName)
  const versionedPath = resolve(outputDirectory, versionedName)
  copyFileSync(builtPath, stablePath)
  copyFileSync(builtPath, versionedPath)

  const checksumPath = resolve(outputDirectory, 'SHA256SUMS')
  const hash = digest(built)
  writeFileSync(checksumPath, `${hash}  ${stableName}\n${hash}  ${versionedName}\n`)
  const notesPath = resolve(outputDirectory, 'release-notes.md')
  writeFileSync(notesPath, `${notes}\n`)

  return {
    version,
    tag,
    stablePath,
    versionedPath,
    checksumPath,
    notesPath,
    sha256: hash,
  }
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
  const outputDirectory = resolve(argument('--output-dir') ?? resolve(root, '.release/userscript'))
  const githubOutput = argument('--github-output')
  const release = prepareUserscriptRelease({ root, outputDirectory })
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
