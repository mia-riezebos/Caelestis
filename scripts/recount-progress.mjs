import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  decodePng,
  decodeWplaceIndexedPng,
  PALETTE_RGB,
  quantiseToPalette,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
} from '../packages/shared/dist/index.js'

/** Count immutable canvas bytes against a cropped artwork chunk, including longitude wrapping. */
export const recountTile = async (template, tile, chunkBytes, canvasBytes) => {
  const chunk = await decodeWplaceIndexedPng(chunkBytes)
  const image = await decodePng(canvasBytes)
  if (chunk === null || image.width !== TILE_SIZE || image.height !== TILE_SIZE)
    throw new Error('Invalid saved artwork or canvas tile')
  const spans =
    template.bbox.minX < template.bbox.maxX
      ? [[template.bbox.minX, template.bbox.maxX]]
      : [
          [template.bbox.minX, WORLD_PIXELS],
          [0, template.bbox.maxX],
        ]
  const span = spans.find(
    ([left, right]) => left < (tile.x + 1) * TILE_SIZE && right > tile.x * TILE_SIZE,
  )
  if (span === undefined) throw new Error('Tile lies outside the template')
  const left = Math.max(0, span[0] - tile.x * TILE_SIZE)
  const top = Math.max(0, template.bbox.minY - tile.y * TILE_SIZE)
  const width = Math.min(TILE_SIZE, span[1] - tile.x * TILE_SIZE) - left
  const height = Math.min(TILE_SIZE, template.bbox.maxY - tile.y * TILE_SIZE) - top
  if (chunk.width !== width || chunk.height !== height)
    throw new Error('Artwork bounds do not match its saved chunk')
  const canvas = quantiseToPalette(image.pixels, PALETTE_RGB).indices
  const result = { correct: 0, wrong: 0, blank: 0 }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const wanted = chunk.indices[y * width + x]
      if (wanted === TRANSPARENT_INDEX) continue
      const actual = canvas[(top + y) * TILE_SIZE + left + x]
      if (actual === TRANSPARENT_INDEX) result.blank++
      else if (actual === wanted) result.correct++
      else result.wrong++
    }
  return result
}

/** Read saved images and write a local SQL repair plan. This function never mutates the server. */
export const prepareProgressRecount = async ({ site, templateId, output }) => {
  const api = new URL('/api/v1/', site)
  const get = async (path) => {
    const response = await fetch(new URL(path, api), { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  const manifest = await (await get('manifest')).json()
  const template = manifest.templates.find((template) => template.id === templateId)
  if (template === undefined) throw new Error('Published template not found')
  if (!/^[0-9a-f-]{36}$/.test(template.version)) throw new Error('Invalid template version')
  const directory = resolve(output)
  await mkdir(directory, { recursive: true })
  const bytes = async (kind, hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid image hash')
    const file = resolve(directory, `${kind}-${hash}.png`)
    let image
    try {
      image = await readFile(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      image = new Uint8Array(await (await get(`${kind}/${hash}`)).arrayBuffer())
    }
    if (createHash('sha256').update(image).digest('hex') !== hash)
      throw new Error(`Image hash mismatch: ${hash}`)
    await writeFile(file, image)
    return image
  }
  const from = Math.floor(template.createdAt / 86400000) * 86400
  const to = Math.floor(Date.now() / 1000) + 1
  const records = []
  for (const chunk of template.chunks) {
    const [x, y] = chunk.tile.split('/').map(Number)
    if (![x, y].every((value) => Number.isInteger(value) && value >= 0 && value < 2048))
      throw new Error('Invalid tile coordinates')
    const hashes = new Set()
    // Include every retained tier, not just the coarsest chart projection. Folding can select a
    // different hash later; its count must already describe those bytes when that happens.
    for (const resolution of [0, 3600, 21600, 86400]) {
      const history = await (
        await get(
          `telemetry/tiles/${x}/${y}/history?season=${manifest.season}&resolution=${resolution}&from=${from}&to=${to}`,
        )
      ).json()
      for (const frame of history.frames) hashes.add(frame.hash)
    }
    const artwork = await bytes('chunks', chunk.hash)
    for (const hash of hashes) {
      records.push({
        versionId: template.version,
        tileX: x,
        tileY: y,
        hash,
        chunkHash: chunk.hash,
        ...(await recountTile(template, { x, y }, artwork, await bytes('tiles', hash))),
      })
    }
    console.log(`${chunk.tile}: recounted ${hashes.size} saved images`)
  }
  const statements = records.map(
    (
      row,
    ) => `INSERT INTO template_tile_measurements (version_id, tile_x, tile_y, sha256, correct, wrong, blank)
SELECT '${row.versionId}', ${row.tileX}, ${row.tileY}, '${row.hash}', ${row.correct}, ${row.wrong}, ${row.blank}
WHERE EXISTS (SELECT 1 FROM version_tiles WHERE version_id = '${row.versionId}' AND tile_x = ${row.tileX} AND tile_y = ${row.tileY} AND hash = '${row.chunkHash}')
  AND (EXISTS (SELECT 1 FROM tile_history WHERE sha256 = '${row.hash}')
    OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = '${row.hash}'))
ON CONFLICT(version_id, tile_x, tile_y, sha256) DO UPDATE SET correct = excluded.correct, wrong = excluded.wrong, blank = excluded.blank;`,
  )
  await writeFile(
    resolve(directory, 'recount.json'),
    JSON.stringify({ templateId, versionId: template.version, from, to, records }, null, 2),
  )
  await writeFile(resolve(directory, 'recount.sql'), `${statements.join('\n')}\n`)
  return { records: records.length, sql: resolve(directory, 'recount.sql') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      template: { type: 'string' },
      output: { type: 'string', default: '.scratch/progress-recount' },
    },
  })
  if (!values.site || !values.template)
    throw new Error('Pass --site and --template; output is local only')
  console.log(
    await prepareProgressRecount({
      site: values.site,
      templateId: values.template,
      output: values.output,
    }),
  )
}
