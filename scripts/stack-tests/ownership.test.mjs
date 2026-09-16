import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageTargets, removeImageReferences } from './image-references.mjs'

test('cleanup removes recorded image targets while preserving replacements and unrelated images', () => {
  const held = new Map([
    ['test:owned', 'sha256:one'],
    ['test:replaced', 'sha256:new'],
    ['other:live', 'sha256:one'],
  ])
  const ctr = (kind, action, reference) => {
    assert.equal(kind, 'images')
    if (action === 'list')
      return `REF TYPE DIGEST\n${[...held].map(([ref, digest]) => `${ref} image/manifest ${digest}`).join('\n')}`
    assert.equal(action, 'remove')
    assert.equal(reference, 'test:owned')
    held.delete(reference)
    return ''
  }
  assert.equal(imageTargets(ctr).get('test:owned'), 'sha256:one')
  assert.deepEqual(
    removeImageReferences(ctr, {
      'test:owned': 'sha256:one',
      'test:replaced': 'sha256:old',
      'test:missing': 'sha256:gone',
    }),
    ['test:replaced'],
  )
  assert.deepEqual([...held.keys()], ['test:replaced', 'other:live'])
})

test('cleanup reports a removal that failed to remove the recorded target', () => {
  assert.throws(
    () =>
      removeImageReferences(
        (_kind, action) =>
          action === 'list' ? 'REF TYPE DIGEST\ntest:stuck image/manifest sha256:one' : '',
        { 'test:stuck': 'sha256:one' },
      ),
    /Image remains/,
  )
})
