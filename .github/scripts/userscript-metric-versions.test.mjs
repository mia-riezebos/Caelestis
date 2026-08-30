import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { userscriptMetricVersions } from './userscript-metric-versions.mjs'

describe('userscript metric version vocabulary', () => {
  it('excludes releases that could not emit metrics', () => {
    assert.deepEqual(userscriptMetricVersions('0.5.4', '## 0.5.4\n\n## 0.5.3\n'), [])
  })

  it('keeps every exact instrumented release across rollout bumps', () => {
    const changelog = ['## 0.6.0', '## 0.5.6', '## 0.5.5', '## 0.5.4'].join('\n\n')

    assert.deepEqual(userscriptMetricVersions('0.6.0', changelog), ['0.6.0', '0.5.6', '0.5.5'])
  })

  it('includes a newly versioned package before its changelog is read back', () => {
    assert.deepEqual(userscriptMetricVersions('0.5.5', '## 0.5.4\n'), ['0.5.5'])
  })
})
