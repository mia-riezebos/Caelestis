import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  encodeIndexedPng,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
} from '../packages/shared/dist/index.js'
import { prepareProgressRecount, recountTile } from './recount-progress.mjs'

const canvas = async (at, values) => {
  const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
  pixels.set(values, at)
  return encodeIndexedPng(TILE_SIZE, TILE_SIZE, pixels)
}

test('recounts cropped saved tiles with blank, wrong, correct and transparent artwork pixels', async () => {
  const chunk = await encodeIndexedPng(4, 1, new Uint8Array([0, 1, 2, TRANSPARENT_INDEX]))
  const png = await canvas(1002, [0, 2, TRANSPARENT_INDEX, 0])
  assert.deepEqual(
    await recountTile({ bbox: { minX: 2, minY: 1, maxX: 6, maxY: 2 } }, { x: 0, y: 0 }, chunk, png),
    { correct: 1, wrong: 1, blank: 1 },
  )
})

test('recounts both sides of a longitude-wrapped template', async () => {
  const template = { bbox: { minX: WORLD_PIXELS - 1, minY: 0, maxX: 1, maxY: 1 } }
  const chunk = await encodeIndexedPng(1, 1, new Uint8Array([0]))
  for (const [x, offset] of [
    [2047, 999],
    [0, 0],
  ]) {
    assert.deepEqual(await recountTile(template, { x, y: 0 }, chunk, await canvas(offset, [0])), {
      correct: 1,
      wrong: 0,
      blank: 0,
    })
  }
})

test('reads all retained tiers and generates repeatable, version-guarded SQL using verified image bytes', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'progress-recount-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const artwork = await encodeIndexedPng(1, 1, new Uint8Array([0]))
  const png = await canvas(0, [0])
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const chunkHash = hash(artwork),
    tileHash = hash(png)
  const version = '01a04bc3-23e6-743f-830e-0b23c33c9d46'
  const requests = []
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    const url = new URL(req.url, 'http://localhost')
    requests.push(url)
    if (url.pathname.endsWith('/manifest'))
      res.end(
        JSON.stringify({
          season: 1,
          templates: [
            {
              id: 'template',
              version,
              createdAt: 1_750_032_000_000,
              bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
              chunks: [{ tile: '0/0', hash: chunkHash }],
            },
          ],
        }),
      )
    else if (url.pathname.endsWith('/history'))
      res.end(JSON.stringify({ frames: [{ hash: tileHash }] }))
    else if (url.pathname.endsWith(`/chunks/${chunkHash}`)) res.end(artwork)
    else if (url.pathname.endsWith(`/tiles/${tileHash}`)) res.end(png)
    else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const site = `http://127.0.0.1:${server.address().port}`
  const plan = await prepareProgressRecount({ site, templateId: 'template', output })
  assert.equal(plan.records, 1)
  assert.deepEqual(
    requests
      .filter((url) => url.pathname.endsWith('/history'))
      .map((url) => url.searchParams.get('resolution')),
    ['0', '3600', '21600', '86400'],
  )
  const sql = await readFile(plan.sql, 'utf8')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const migrations = new URL('../apps/backend/migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort())
    db.exec(await readFile(new URL(file, migrations), 'utf8'))
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec(sql)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_tile_measurements').get().n, 0)
  db.prepare(
    'INSERT INTO version_tiles (version_id, tile_x, tile_y, hash) VALUES (?, 0, 0, ?)',
  ).run(version, chunkHash)
  db.exec(sql)
  db.exec(sql)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_tile_measurements').get().n, 0)
  db.prepare(
    'INSERT INTO canvas_tiles (season, tile_x, tile_y, sha256, observed_at_ms) VALUES (1, 0, 0, ?, 0)',
  ).run(tileHash)
  db.exec(sql)
  db.exec(sql)
  assert.deepEqual(
    { ...db.prepare('SELECT correct, wrong, blank FROM template_tile_measurements').get() },
    { correct: 1, wrong: 0, blank: 0 },
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_tile_measurements').get().n, 1)
  await writeFile(join(output, `tiles-${tileHash}.png`), 'corrupt')
  await assert.rejects(
    prepareProgressRecount({ site, templateId: 'template', output }),
    /Image hash mismatch/,
  )
})
