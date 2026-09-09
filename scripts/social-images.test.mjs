import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { TILE_SIZE, WORLD_PIXELS } from '../packages/shared/dist/index.js'
import {
  buildSocialImages,
  captureSamples,
  renderTimelapse,
  sampleTimeline,
} from './social-images.mjs'

const template = {
  id: 'test-template',
  version: 'art-v1',
  name: 'Test',
  published: true,
  bbox: { minX: 100, minY: 100, maxX: 116, maxY: 109 },
  createdAt: 0,
  finishedAt: null,
  finished: false,
}
const tile = (colour) =>
  sharp({
    create: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      channels: 4,
      background: colour,
    },
  })
    .png()
    .toBuffer()

test('samples the entire retained timeline, preserving both endpoints', () => {
  assert.deepEqual(sampleTimeline([9, 1, 5, 1, 3, 7], 3), [1, 5, 9])
})

test('sampling wraps longitude and stays within polar canvas bounds', () => {
  const seam = captureSamples({ minX: WORLD_PIXELS - 8, minY: 0, maxX: 8, maxY: 9 }, 16, 9)
  assert.deepEqual([...seam.keys()], ['2047/0', '0/0'])
  assert.equal([...seam.values()].flat().length, 144)
  assert.ok(
    [...seam.values()]
      .flat()
      .every(([, source]) => source >= 0 && source < TILE_SIZE * TILE_SIZE * 4),
  )
})

test('GIF starts with current pixels, then plays history without leaking future observations', async () => {
  const red = await tile('#ff0000')
  const blue = await tile('#0000ff')
  const reads = []
  const gif = await renderTimelapse({
    template,
    histories: new Map([
      [
        '0/0',
        [
          { bucketStart: 10, hash: 'red' },
          { bucketStart: 20, hash: 'blue' },
        ],
      ],
    ]),
    canvas: new Map([['0/0', 'blue']]),
    readTile: async (hash) => {
      reads.push(hash)
      return hash === 'red' ? red : blue
    },
    width: 16,
    height: 9,
  })
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a')
  const metadata = await sharp(gif, { animated: true }).metadata()
  assert.equal(metadata.width, 16)
  assert.equal(metadata.pageHeight, 9)
  assert.equal(metadata.loop, 0)
  assert.ok(metadata.pages >= 3)
  const first = await sharp(gif, { page: 0 }).removeAlpha().raw().toBuffer()
  const past = await sharp(gif, { page: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...first.subarray(0, 3)], [0, 0, 255])
  assert.deepEqual([...past.subarray(0, 3)], [255, 0, 0])
  assert.deepEqual(reads.sort(), ['blue', 'red'])
})

test('finished previews exclude the live canvas and missing history has no fabricated image', async () => {
  const options = {
    template: { ...template, finished: true },
    histories: new Map(),
    canvas: new Map([['0/0', 'live']]),
    readTile: () => {
      throw new Error('must not read live canvas')
    },
    width: 16,
    height: 9,
  }
  assert.equal(await renderTimelapse(options), null)
  const red = await tile('#ff0000')
  const gif = await renderTimelapse({
    ...options,
    histories: new Map([['0/0', [{ bucketStart: 10, hash: 'archive' }]]]),
    readTile: async (hash) => {
      assert.equal(hash, 'archive')
      return red
    },
  })
  const pixel = await sharp(gif).removeAlpha().raw().toBuffer()
  assert.deepEqual([...pixel.subarray(0, 3)], [255, 0, 0])
})

test('tiles first observed later stay neutral in earlier frames', async () => {
  const red = await tile('#ff0000')
  const blue = await tile('#0000ff')
  const gif = await renderTimelapse({
    template: { ...template, bbox: { minX: 992, minY: 0, maxX: 1008, maxY: 9 } },
    histories: new Map([
      ['0/0', [{ bucketStart: 5, hash: 'red' }]],
      ['1/0', [{ bucketStart: 10, hash: 'blue' }]],
    ]),
    canvas: new Map([
      ['0/0', 'red'],
      ['1/0', 'blue'],
    ]),
    readTile: async (hash) => (hash === 'red' ? red : blue),
    width: 16,
    height: 9,
  })
  const past = await sharp(gif, { page: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...past.subarray(0, 3)], [255, 0, 0])
  assert.deepEqual([...past.subarray(8 * 3, 9 * 3)], [27, 27, 32])
})

test('a failed template does not stop other outputs, and unpublished templates are skipped', async (t) => {
  const png = await tile('#4093e4')
  const output = await mkdtemp(join(tmpdir(), 'caelestis-social-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/api/v1/manifest') {
      response.end(
        JSON.stringify({
          season: 0,
          templates: [
            { ...template, id: 'broken', bbox: { minX: 1100, minY: 100, maxX: 1116, maxY: 109 } },
            template,
            { ...template, id: 'private', published: false },
          ],
        }),
      )
    } else if (url.pathname === '/api/v1/telemetry/canvas') {
      response.end(JSON.stringify({ tiles: [{ tile: '0/0', hash: 'blue' }] }))
    } else if (url.pathname === '/api/v1/telemetry/tiles/0/0/history') {
      response.end(JSON.stringify({ frames: [{ bucketStart: 10, hash: 'blue' }] }))
    } else if (url.pathname === '/api/v1/tiles/blue') {
      response.setHeader('content-type', 'image/png')
      response.end(png)
    } else {
      response.writeHead(503).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  await assert.rejects(
    buildSocialImages({ site: `http://127.0.0.1:${server.address().port}`, output }),
    /failed for broken/,
  )
  assert.deepEqual(await readdir(output), ['test-template.gif'])
})
