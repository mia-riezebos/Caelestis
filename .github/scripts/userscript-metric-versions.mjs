import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIRST_METRICS_VERSION = '0.5.5'
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

const parts = (version) => {
  const match = VERSION.exec(version)
  if (match === null) throw new Error(`invalid userscript version: ${version}`)
  return match.slice(1).map(Number)
}

const compareVersions = (left, right) => {
  const leftParts = parts(left)
  const rightParts = parts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference
  }
  return 0
}

/** Exact released builds that emit client metrics, newest first. */
export const userscriptMetricVersions = (packageVersion, changelog) => {
  parts(packageVersion)
  const versions = new Set([packageVersion])
  for (const match of changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)) {
    versions.add(match[1])
  }
  return [...versions]
    .filter((version) => compareVersions(version, FIRST_METRICS_VERSION) >= 0)
    .sort((left, right) => compareVersions(right, left))
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(process.cwd())
  const packageJson = JSON.parse(
    readFileSync(resolve(root, 'apps/userscript/package.json'), 'utf8'),
  )
  const changelog = readFileSync(resolve(root, 'apps/userscript/CHANGELOG.md'), 'utf8')
  process.stdout.write(
    `${JSON.stringify(userscriptMetricVersions(packageJson.version, changelog))}\n`,
  )
}
