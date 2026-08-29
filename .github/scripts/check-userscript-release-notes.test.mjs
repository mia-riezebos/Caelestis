import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertPendingChangesetImmutable,
  validatePendingUserscriptChangeset,
  validateUserscriptChangeset,
} from './check-userscript-release-notes.mjs'

const changeset = (body) => `---\n'@caelestis/userscript': patch\n---\n\n${body}\n`
const backendChangeset = (body) => `---\n'@caelestis/backend': patch\n---\n\n${body}\n`

describe('userscript Changeset release notes', () => {
  it('accepts a short summary with closely related detail bullets', () => {
    assert.equal(
      validateUserscriptChangeset(
        changeset(`Keep dense markers useful without overwhelming slower clients.

- Protect isolated markers while sharing the dense-marker target.
- Skip GPU work when markers are disabled.`),
      ),
      true,
    )
  })

  it('rejects long aggregate prose', () => {
    assert.throws(
      () =>
        validateUserscriptChangeset(changeset(`${'Combine unrelated release work. '.repeat(8)}`)),
      /summary exceeds 200 characters/,
    )
  })

  it('rejects multiple sentences in the summary', () => {
    assert.throws(
      () => validateUserscriptChangeset(changeset('Fix the editor. Change the renderer.')),
      /summary must be exactly one complete sentence/,
    )
  })

  it('requires additional detail to use a readable bullet list', () => {
    assert.throws(
      () =>
        validateUserscriptChangeset(
          changeset('Keep release notes readable.\n\nAppend another prose paragraph.'),
        ),
      /details must be Markdown bullets/,
    )
  })

  it('rejects edits to a Changeset that already exists on the base branch', () => {
    assert.throws(
      () =>
        assertPendingChangesetImmutable({
          current: changeset('Absorb another change.'),
          base: changeset('Describe one change.'),
          path: '.changeset/example.md',
        }),
      /add a new Changeset instead of editing a pending one/,
    )
  })

  it('protects a base userscript Changeset when its package declaration changes', () => {
    assert.throws(
      () =>
        validatePendingUserscriptChangeset({
          current: backendChangeset('Reassign the release note.'),
          base: changeset('Describe one userscript change.'),
          path: '.changeset/example.md',
        }),
      /add a new Changeset instead of editing a pending one/,
    )
  })
})
