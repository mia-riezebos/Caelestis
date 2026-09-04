import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { prepareAppRelease } from './prepare-app-release.mjs'

describe('app release preparation', () => {
  it('prepares the current frontend changelog section', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'caelestis-app-release-test-'))
    const frontend = resolve(root, 'apps/frontend')
    const outputDirectory = resolve(root, 'release')
    mkdirSync(frontend, { recursive: true })
    writeFileSync(
      resolve(frontend, 'package.json'),
      JSON.stringify({ name: '@caelestis/frontend', version: '1.2.3' }),
    )
    writeFileSync(
      resolve(frontend, 'CHANGELOG.md'),
      '## 1.2.3\n\n### Minor Changes\n\n- abc1234: Current.\n\n## 1.2.2\n\n- Old.\n',
    )

    const release = prepareAppRelease({ root, outputDirectory, app: 'frontend' })

    assert.deepEqual(release, {
      app: 'frontend',
      version: '1.2.3',
      tag: 'frontend-v1.2.3',
      notesPath: resolve(outputDirectory, 'release-notes.md'),
    })
    assert.equal(
      readFileSync(release.notesPath, 'utf8'),
      '### Minor Changes\n\n- abc1234: Current.\n',
    )
  })

  it('rejects internal packages', () => {
    assert.throws(
      () => prepareAppRelease({ root: '.', outputDirectory: '.', app: 'shared' }),
      /unsupported release app/,
    )
  })
})
