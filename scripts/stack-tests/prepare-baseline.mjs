import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { run } from './process.mjs'

// Before the first portable release, verify upgrades from the tested initial portable baseline.
const firstBaseline = '6884c40704b63c75e8ed0549860df348db325600'
const [arch] = process.argv.slice(2)
assert.ok(['amd64', 'arm64'].includes(arch), 'Usage: prepare-baseline.mjs amd64|arm64')
const repository = process.env.GITHUB_REPOSITORY ?? 'mia-riezebos/Caelestis'
const version = (app) => JSON.parse(readFileSync(`apps/${app}/package.json`, 'utf8')).version
const candidate = `server-backend-${version('backend')}-frontend-${version('frontend')}`
const releases = JSON.parse(
  execFileSync('gh', ['api', `repos/${repository}/releases`, '--paginate', '--slurp'], {
    encoding: 'utf8',
  }),
).flat()
const previous = releases.find(
  (release) =>
    !release.draft &&
    !release.prerelease &&
    /^server-backend-\d+\.\d+\.\d+-frontend-\d+\.\d+\.\d+$/.test(release.tag_name) &&
    release.tag_name !== candidate,
)
const directory = mkdtempSync(join(tmpdir(), 'caelestis-baseline-'))
mkdirSync('images', { recursive: true })
const log = resolve('test-results/baseline/build.log')
try {
  if (previous) {
    execFileSync(
      'gh',
      [
        'release',
        'download',
        previous.tag_name,
        '--repo',
        repository,
        '--dir',
        directory,
        '--pattern',
        '*-image.txt',
        '--pattern',
        'SHA256SUMS',
      ],
      { stdio: 'inherit' },
    )
    const sums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8')
    const { createHash } = await import('node:crypto')
    for (const component of ['backend', 'frontend']) {
      const file = `${component}-image.txt`
      const bytes = readFileSync(join(directory, file))
      const expected = sums
        .split('\n')
        .find((line) => line.endsWith(`  ${file}`))
        ?.split(' ')[0]
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${file} checksum`)
      const image = bytes.toString().trim()
      assert.match(
        image,
        new RegExp(`^docker.io/miacx/caelestis-${component}@sha256:[a-f0-9]{64}$`),
      )
      await run('docker', ['pull', '--platform', `linux/${arch}`, image], { log })
      execFileSync('docker', ['tag', image, `caelestis-${component}:baseline`])
    }
    writeFileSync('images/baseline.json', JSON.stringify({ release: previous.tag_name }))
  } else {
    execFileSync('git', ['fetch', '--depth=1', 'origin', firstBaseline], { stdio: 'inherit' })
    const archive = execFileSync('git', ['archive', firstBaseline], { maxBuffer: 64 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    for (const component of ['backend', 'frontend'])
      await run(
        'docker',
        [
          'buildx',
          'build',
          '--target',
          component,
          '--platform',
          `linux/${arch}`,
          '--build-arg',
          `CAELESTIS_BUILD_ID=${firstBaseline}`,
          '--tag',
          `caelestis-${component}:baseline`,
          '--load',
          directory,
        ],
        { log, timeout: 900_000 },
      )
    writeFileSync(
      'images/baseline.json',
      JSON.stringify({ source: firstBaseline, reason: 'No previous portable release exists' }),
    )
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
