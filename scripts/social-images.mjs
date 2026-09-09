import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import {
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_WIDTH,
  socialImageKey,
} from '../apps/frontend/src/lib/social-image.ts'
import { TILE_SIZE, timelapseCaptureRect, WORLD_PIXELS } from '../packages/shared/dist/index.js'

const MAX_FRAMES = 32
const MAX_GIF_BYTES = 4_500_000
const BACKGROUND = [27, 27, 32]
const FRAME_DELAY = 250
const POSTER_DELAY = 1_500

/** Evenly sample observed times, preserving the beginning and end of retained history. */
export const sampleTimeline = (times, limit = MAX_FRAMES) => {
  const sorted = [...new Set(times)].sort((a, b) => a - b)
  if (sorted.length <= limit) return sorted
  return Array.from(
    { length: limit },
    (_, index) => sorted[Math.round((index * (sorted.length - 1)) / (limit - 1))],
  )
}

/** Map output pixels to native tile pixels, including longitude wrap and fractional capture bounds. */
export const captureSamples = (bbox, width = SOCIAL_IMAGE_WIDTH, height = SOCIAL_IMAGE_HEIGHT) => {
  const rect = timelapseCaptureRect(bbox)
  const tiles = new Map()
  for (let y = 0; y < height; y++) {
    const worldY = Math.floor(rect.y + ((y + 0.5) * rect.height) / height)
    for (let x = 0; x < width; x++) {
      const unwrappedX = Math.floor(rect.x + ((x + 0.5) * rect.width) / width)
      const worldX = ((unwrappedX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
      const key = `${Math.floor(worldX / TILE_SIZE)}/${Math.floor(worldY / TILE_SIZE)}`
      const samples = tiles.get(key) ?? []
      samples.push([
        (y * width + x) * 3,
        ((worldY % TILE_SIZE) * TILE_SIZE + (worldX % TILE_SIZE)) * 4,
      ])
      tiles.set(key, samples)
    }
  }
  return tiles
}

const hashAt = (frames, time) => {
  let hash
  for (const frame of frames) {
    if (frame.bucketStart > time) break
    hash = frame.hash
  }
  return hash
}

/** Render native canvas history. Missing observations stay neutral; the first frame is the latest view. */
export const renderTimelapse = async ({
  template,
  histories,
  canvas,
  readTile,
  width = SOCIAL_IMAGE_WIDTH,
  height = SOCIAL_IMAGE_HEIGHT,
}) => {
  const timeline = sampleTimeline(
    [...histories.values()].flatMap((frames) => frames.map((frame) => frame.bucketStart)),
  )
  const times = [null, ...timeline]
  const frames = times.map(() => Buffer.alloc(width * height * 3, Buffer.from(BACKGROUND)))
  let observed = false
  for (const [key, samples] of captureSamples(template.bbox, width, height)) {
    const history = [...(histories.get(key) ?? [])].sort((a, b) => a.bucketStart - b.bucketStart)
    const latest = template.finished
      ? history.at(-1)?.hash
      : (canvas.get(key) ?? history.at(-1)?.hash)
    const byHash = new Map()
    for (const [index, time] of times.entries()) {
      const hash = time === null ? latest : hashAt(history, time)
      if (hash === undefined) continue
      const destinations = byHash.get(hash) ?? []
      destinations.push(frames[index])
      byHash.set(hash, destinations)
    }
    for (const [hash, destinations] of byHash) {
      const { data, info } = await sharp(await readTile(hash))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (info.width !== TILE_SIZE || info.height !== TILE_SIZE || info.channels !== 4) {
        throw new Error(`Unexpected canvas tile dimensions for ${hash}`)
      }
      observed = true
      for (const destination of destinations) {
        for (const [target, source] of samples) {
          const alpha = data[source + 3] / 255
          for (let channel = 0; channel < 3; channel++) {
            destination[target + channel] = Math.round(
              data[source + channel] * alpha + BACKGROUND[channel] * (1 - alpha),
            )
          }
        }
      }
    }
  }
  if (!observed) return null
  // Repeat the poster at the end so playback reaches the current canvas before looping.
  if (timeline.length > 0) frames.push(frames[0])
  let selected = frames
  while (true) {
    const gif = await sharp(Buffer.concat(selected), {
      raw: { width, height: height * selected.length, channels: 3, pageHeight: height },
    })
      .gif({
        loop: 0,
        delay: selected.map((_, index) =>
          index === 0 || index === selected.length - 1 ? POSTER_DELAY : FRAME_DELAY,
        ),
        colours: 128,
        dither: 0,
      })
      .toBuffer()
    if (gif.length <= MAX_GIF_BYTES) return gif
    if (selected.length <= 3) throw new Error('Timelapse exceeds the share image size limit')
    selected = [
      selected[0],
      ...selected.slice(1, -1).filter((_, index) => index % 2 === 0),
      selected.at(-1),
    ]
  }
}

/** Build locally by default. Only --publish writes the resulting GIFs to the configured R2 bucket. */
export const buildSocialImages = async ({
  site,
  output,
  publish = false,
  bucket = 'caelestis-blobs',
  templateId,
}) => {
  const api = new URL('/api/v1/', site)
  const read = async (path, init) => {
    const response = await fetch(new URL(path, api), {
      signal: AbortSignal.timeout(60_000),
      ...init,
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  const manifest = await (await read('manifest')).json()
  const canvasResponse = await (await read(`telemetry/canvas?season=${manifest.season}`)).json()
  const canvas = new Map(canvasResponse.tiles.map((tile) => [tile.tile, tile.hash]))
  await mkdir(output, { recursive: true })
  const failures = []
  for (const template of manifest.templates.filter(
    (entry) => entry.published && (!templateId || entry.id === templateId),
  )) {
    try {
      const from = Math.floor(template.createdAt / 1_000)
      const to = Math.floor((template.finishedAt ?? Date.now()) / 1_000) + 1
      const histories = new Map()
      const keys = [...captureSamples(template.bbox).keys()]
      for (let index = 0; index < keys.length; index += 4) {
        await Promise.all(
          keys.slice(index, index + 4).map(async (key) => {
            const response = await read(
              `telemetry/tiles/${key}/history?season=${manifest.season}&from=${from}&to=${to}`,
            )
            histories.set(key, (await response.json()).frames)
          }),
        )
      }
      const gif = await renderTimelapse({
        template,
        histories,
        canvas,
        readTile: async (hash) => Buffer.from(await (await read(`tiles/${hash}`)).arrayBuffer()),
      })
      if (gif === null) {
        console.log(`${template.id}: no snapshots yet`)
        continue
      }
      const file = resolve(output, `${encodeURIComponent(template.id)}.gif`)
      await writeFile(file, gif)
      if (publish) {
        const previous = await fetch(
          new URL(`/social/template/${encodeURIComponent(template.id)}.gif`, site),
          {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          },
        )
        const etag = `"${createHash('md5').update(gif).digest('hex')}"`
        if (previous.ok && previous.headers.get('etag') === etag) {
          console.log(`${template.id}: unchanged`)
          continue
        }
        execFileSync(
          'pnpm',
          [
            '--dir',
            'apps/frontend',
            'exec',
            'wrangler',
            'r2',
            'object',
            'put',
            `${bucket}/${socialImageKey(manifest.season, template)}`,
            '--remote',
            '--file',
            file,
            '--content-type',
            'image/gif',
          ],
          { stdio: 'inherit' },
        )
      }
      console.log(`${template.id}: ${gif.length} bytes${publish ? ', published' : ''}`)
    } catch (error) {
      console.error(`${template.id}:`, error)
      failures.push(template.id)
    }
  }
  if (failures.length > 0) throw new Error(`Preview generation failed for ${failures.join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      output: { type: 'string', default: '.scratch/social-images' },
      publish: { type: 'boolean', default: false },
      bucket: { type: 'string', default: 'caelestis-blobs' },
      template: { type: 'string' },
    },
  })
  if (!values.site) throw new Error('Pass --site with the frontend URL to read')
  await buildSocialImages({ ...values, templateId: values.template })
}
