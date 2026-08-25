import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { prepareUserscriptRelease, releaseNotesFor } from './prepare-userscript-release.mjs'

describe('userscript release preparation', () => {
  it('extracts only the current Changesets changelog section', () => {
    const changelog = '# @caelestis/userscript\n\n## 1.2.0\n\n- Current\n\n## 1.1.0\n\n- Old\n'
    assert.equal(releaseNotesFor(changelog, '1.2.0'), '- Current')
  })

  it('stages stable and versioned installers with checksums', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'caelestis-release-test-'))
    const userscript = resolve(root, 'apps/userscript')
    const outputDirectory = resolve(root, 'release')
    mkdirSync(resolve(userscript, 'dist'), { recursive: true })
    writeFileSync(
      resolve(userscript, 'package.json'),
      JSON.stringify({ name: '@caelestis/userscript', version: '1.2.3' }),
    )
    writeFileSync(
      resolve(userscript, 'CHANGELOG.md'),
      '## 1.2.3\n\n### Minor Changes\n\n- Ship it.\n',
    )
    const installer = '// ==UserScript==\n// @version      1.2.3\n// ==/UserScript==\n'
    writeFileSync(resolve(userscript, 'dist/wplace-template-server.user.js'), installer)

    const release = prepareUserscriptRelease({ root, outputDirectory })

    assert.equal(release.tag, 'userscript-v1.2.3')
    assert.equal(readFileSync(release.stablePath, 'utf8'), installer)
    assert.equal(readFileSync(release.versionedPath, 'utf8'), installer)
    assert.match(readFileSync(release.checksumPath, 'utf8'), /caelestis\.user\.js/)
    assert.equal(readFileSync(release.notesPath, 'utf8'), '### Minor Changes\n\n- Ship it.\n')
  })
})
