import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeIndexedPng, TRANSPARENT_INDEX } from '../packages/shared/dist/index.js'
import { recountTile } from './recount-progress.mjs'

test('recounts saved cropped artwork with correct, wrong, blank and ignored pixels', async () => {
  const artwork = await encodeIndexedPng(4, 1, new Uint8Array([1, 1, 1, TRANSPARENT_INDEX]))
  const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
  indices.set([1, 2, TRANSPARENT_INDEX, 3], 500100)
  const canvas = await encodeIndexedPng(1000, 1000, indices)
  const template = { bbox: { minX: 1100, minY: 2500, maxX: 1104, maxY: 2501 } }
  assert.deepEqual(await recountTile(template, { x: 1, y: 2 }, artwork, canvas), {
    correct: 1,
    wrong: 1,
    blank: 1,
  })
  await assert.rejects(
    recountTile(template, { x: 3, y: 2 }, artwork, canvas),
    /outside the template/,
  )
  await assert.rejects(
    recountTile({ bbox: { ...template.bbox, maxX: 1105 } }, { x: 1, y: 2 }, artwork, canvas),
    /bounds do not match/,
  )
})
