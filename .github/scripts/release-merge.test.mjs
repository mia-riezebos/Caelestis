import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { isReleaseMerge } from './release-merge.mjs'

const sha = 'a'.repeat(40)
const repository = 'owner/repo'
const release = {
  merged_at: '2026-09-10T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: 'main' },
  head: { ref: 'changeset-release/main', repo: { full_name: repository } },
}

describe('release merge authorization', () => {
  it('accepts the merged release PR at its exact main commit', () => {
    assert.equal(isReleaseMerge([release], { sha, repository }), true)
  })

  it('reads every page from the GitHub CLI and emits one boolean', () => {
    const result = execFileSync(
      process.execPath,
      [new URL('./release-merge.mjs', import.meta.url).pathname, sha, repository],
      {
        input: JSON.stringify([[], [release]]),
        encoding: 'utf8',
      },
    )
    assert.equal(result, 'true\n')
  })

  it('rejects ordinary merges, direct pushes, and unmerged release PRs', () => {
    for (const prs of [
      [],
      [{ ...release, head: { ...release.head, ref: 'fix/example' } }],
      [{ ...release, merged_at: null }],
      [{ ...release, base: { ref: 'development' } }],
    ])
      assert.equal(isReleaseMerge(prs, { sha, repository }), false)
  })

  it('rejects a release PR associated with a different commit or a fork', () => {
    assert.equal(isReleaseMerge([release], { sha: 'b'.repeat(40), repository }), false)
    assert.equal(isReleaseMerge([release], { sha, repository: 'another/repo' }), false)
    assert.equal(
      isReleaseMerge([{ ...release, head: { ...release.head, repo: null } }], { sha, repository }),
      false,
    )
  })
})
