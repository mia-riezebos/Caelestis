import {
  type ArchiveHistory,
  decodePng,
  type Template,
  TILE_SIZE,
  type TileHistoryResponse,
  timelapseCaptureRect,
  WORLD_PIXELS,
} from '@caelestis/shared'
import gifenc from 'gifenc/dist/gifenc.js'
import { mergeArchiveFrames, type PlaybackFrame } from './archive-history.ts'
import { stampMapAttribution } from './social-attribution.ts'
import { type ReadMapTile, renderBasemap } from './social-basemap.ts'
import { SOCIAL_IMAGE_HEIGHT, SOCIAL_IMAGE_WIDTH } from './social-image.ts'

const MAX_FPS = 30
const HISTORY_PLAYBACK_SECONDS = 10
const MAX_FRAMES = MAX_FPS * HISTORY_PLAYBACK_SECONDS
const MAX_SOURCE_IMAGES = 4096
const GIF_TICK_MS = 10
const LIVE_PAUSE_MS = 5000
const MAX_GIF_BYTES = 4_500_000
const BACKGROUND = [27, 27, 32, 255]
const { applyPalette, GIFEncoder, quantize } = gifenc

/** Sample the retained timeline evenly, preserving both endpoints. */
export const sampleTimeline = (times: readonly number[], limit = MAX_FRAMES): number[] => {
  const sorted = [...new Set(times)].sort((a, b) => a - b)
  if (sorted.length <= limit) return sorted
  return Array.from(
    { length: limit },
    (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (limit - 1))],
  )
}

/** Map output pixels to native tile pixels, including longitude wrap. */
export const captureSamples = (
  bbox: Template['bbox'],
  width = SOCIAL_IMAGE_WIDTH,
  height = SOCIAL_IMAGE_HEIGHT,
) => {
  const rect = timelapseCaptureRect(bbox)
  const tiles = new Map<string, [number, number][]>()
  for (let y = 0; y < height; y++) {
    const worldY = Math.floor(rect.y + ((y + 0.5) * rect.height) / height)
    for (let x = 0; x < width; x++) {
      const rawX = Math.floor(rect.x + ((x + 0.5) * rect.width) / width)
      const worldX = ((rawX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
      const key = `${Math.floor(worldX / TILE_SIZE)}/${Math.floor(worldY / TILE_SIZE)}`
      const samples = tiles.get(key) ?? []
      samples.push([
        (y * width + x) * 4,
        ((worldY % TILE_SIZE) * TILE_SIZE + (worldX % TILE_SIZE)) * 4,
      ])
      tiles.set(key, samples)
    }
  }
  return tiles
}

/** Play ten seconds of observed history, retaining gaps, then hold the latest view for five seconds. */
export const renderTimelapse = async ({
  template,
  histories,
  canvas,
  readTile,
  artwork = false,
  readMapTile,
  width = SOCIAL_IMAGE_WIDTH,
  height = SOCIAL_IMAGE_HEIGHT,
}: {
  template: Pick<Template, 'bbox' | 'finished'>
  histories: ReadonlyMap<string, readonly PlaybackFrame[]>
  canvas: ReadonlyMap<string, string>
  readTile: (hash: string) => Promise<Uint8Array>
  artwork?: boolean
  readMapTile?: ReadMapTile
  width?: number
  height?: number
}): Promise<Uint8Array | null> => {
  const samplesByTile = captureSamples(template.bbox, width, height)
  // Reserve one source image per tile for the live hold, retaining both history endpoints.
  const frameLimit = Math.min(
    MAX_FRAMES,
    Math.max(2, Math.floor(MAX_SOURCE_IMAGES / samplesByTile.size) - 1),
  )
  const timeline = sampleTimeline(
    [...histories.values()].flatMap((frames) => frames.map((frame) => frame.bucketStart)),
    frameLimit,
  )
  const times = [...timeline, null]
  const background = readMapTile
    ? await renderBasemap(template.bbox, width, height, readMapTile)
    : Uint8Array.from({ length: width * height * 4 }, (_, i) => BACKGROUND[i % 4])
  const frames = times.map(() => background.slice())
  let observed = false
  for (const [key, samples] of samplesByTile) {
    const history = [...(histories.get(key) ?? [])].sort((a, b) => a.bucketStart - b.bucketStart)
    const latest = template.finished
      ? history.at(-1)?.hash
      : (canvas.get(key) ?? history.at(-1)?.hash)
    const byHash = new Map<string, Uint8Array[]>()
    for (const [index, time] of times.entries()) {
      const hash =
        time === null ? latest : history.findLast((frame) => frame.bucketStart <= time)?.hash
      if (hash === undefined) continue
      const destinations = byHash.get(hash) ?? []
      destinations.push(frames[index])
      byHash.set(hash, destinations)
    }
    for (const [hash, destinations] of byHash) {
      const image = await decodePng(await readTile(hash))
      if (!artwork && (image.width !== TILE_SIZE || image.height !== TILE_SIZE))
        throw new Error(`Unexpected tile dimensions for ${hash}`)
      const [tileX, tileY] = key.split('/').map(Number)
      const offsetX =
        artwork && tileX === Math.floor(template.bbox.minX / TILE_SIZE)
          ? template.bbox.minX % TILE_SIZE
          : 0
      const offsetY =
        artwork && tileY === Math.floor(template.bbox.minY / TILE_SIZE)
          ? template.bbox.minY % TILE_SIZE
          : 0
      observed = true
      for (const destination of destinations) {
        for (const [target, source] of samples) {
          const x = ((source / 4) % TILE_SIZE) - offsetX
          const y = Math.floor(source / 4 / TILE_SIZE) - offsetY
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
          const pixel = (y * image.width + x) * 4
          const alpha = image.pixels[pixel + 3] / 255
          for (let channel = 0; channel < 3; channel++) {
            destination[target + channel] = Math.round(
              image.pixels[pixel + channel] * alpha + destination[target + channel] * (1 - alpha),
            )
          }
        }
      }
    }
  }
  if (!observed) return null
  if (readMapTile) await stampMapAttribution(frames, width, height)
  let selected = frames
  while (true) {
    const gif = GIFEncoder()
    const historyFrames = selected.length - 1
    const historyTicks = (HISTORY_PLAYBACK_SECONDS * 1000) / GIF_TICK_MS
    for (const [index, frame] of selected.entries()) {
      const palette = quantize(frame, 128)
      // Divide the full ten seconds again after size reduction, using GIF's 10 ms ticks.
      const delay =
        index === historyFrames
          ? LIVE_PAUSE_MS
          : (Math.ceil(((index + 1) * historyTicks) / historyFrames) -
              Math.ceil((index * historyTicks) / historyFrames)) *
            GIF_TICK_MS
      gif.writeFrame(applyPalette(frame, palette), width, height, {
        palette,
        repeat: 0,
        delay,
      })
    }
    gif.finish()
    const bytes = gif.bytes()
    if (bytes.length <= MAX_GIF_BYTES) return bytes
    if (selected.length <= 3) throw new Error('Timelapse exceeds the share image size limit')
    selected = [...selected.slice(0, -2).filter((_, i) => i % 2 === 0), ...selected.slice(-2)]
  }
}

/** Merge native observations with this version's sparse backfill before rendering. */
export const renderTemplateHistory = async (
  template: Template,
  season: number,
  canvas: ReadonlyMap<string, string>,
  read: (path: string) => Promise<Response>,
  readMapTile?: ReadMapTile,
) => {
  const from = Math.floor(template.createdAt / 1000)
  const to = Math.floor((template.finishedAt ?? Date.now()) / 1000) + 1
  const histories = new Map<string, readonly PlaybackFrame[]>()
  for (const key of captureSamples(template.bbox).keys()) {
    const [x, y] = key.split('/')
    const live: TileHistoryResponse = await (
      await read(`telemetry/tiles/${key}/history?season=${season}&from=${from}&to=${to}`)
    ).json()
    const archive: ArchiveHistory = await (
      await read(
        `archive/templates/${encodeURIComponent(template.id)}?version=${encodeURIComponent(template.version)}&x=${x}&y=${y}`,
      )
    ).json()
    histories.set(
      key,
      mergeArchiveFrames(
        live,
        archive.frames.filter((frame) => frame.at < to),
      ),
    )
  }
  return renderTimelapse({
    template,
    histories,
    canvas,
    readMapTile,
    readTile: async (hash) =>
      new Uint8Array(
        await (
          await read(
            hash.startsWith('archive:') ? `archive/tiles/${hash.slice(8)}` : `tiles/${hash}`,
          )
        ).arrayBuffer(),
      ),
  })
}
