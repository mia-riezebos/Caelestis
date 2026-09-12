import assert from 'node:assert/strict'
import { it } from 'node:test'
import { portableVersion } from './prepare-portable-release.mjs'

it('changes artifact versions when either app changes', () => {
  const initial = portableVersion('1.2.3', '4.5.6')
  assert.equal(initial.chartVersion, '1.2.3+frontend.4.5.6')
  assert.equal(initial.tag, 'server-backend-1.2.3-frontend-4.5.6')
  for (const next of [portableVersion('1.2.4', '4.5.6'), portableVersion('1.2.3', '4.5.7')]) {
    assert.notEqual(initial.imageTag, next.imageTag)
    assert.notEqual(initial.chartVersion, next.chartVersion)
  }
})

it('rejects prerelease, malformed, and shell-active version strings', () => {
  for (const invalid of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-beta.1', '1.0.0+build', '$(command)'])
    assert.throws(() => portableVersion(invalid, '1.0.0'))
})
