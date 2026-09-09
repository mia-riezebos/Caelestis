import { type Template, timelapseCaptureRect, WORLD_PIXELS } from '@caelestis/shared'
import { convertIndexedToRgb, decode } from 'fast-png'
import { OSM_TILE_SIZE, osmSpan, osmZoomFor } from './osm-geometry.ts'

export type ReadMapTile = (z: number, x: number, y: number) => Promise<Uint8Array>
export const MAP_CACHE_MS = 7 * 24 * 60 * 60 * 1000

/** Identify this renderer to OSM; callers cache successful tile reads for at least seven days. */
export const fetchMapTile: ReadMapTile = async (z, x, y) => {
  const response = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers: {
      'User-Agent': 'CaelestisShareImages/1.0 (+https://github.com/mia-riezebos/Caelestis)',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`OpenStreetMap tile ${z}/${x}/${y}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Rasterize the same Web Mercator map beneath the viewer at the GIF's capture bounds. */
export const renderBasemap = async (
  bbox: Template['bbox'],
  width: number,
  height: number,
  read: ReadMapTile,
) => {
  const rect = timelapseCaptureRect(bbox)
  const z = osmZoomFor(width / rect.width, 0)
  const span = osmSpan(z)
  const samples = new Map<string, [number, number][]>()
  for (let y = 0; y < height; y++) {
    const worldY = rect.y + ((y + 0.5) * rect.height) / height
    for (let x = 0; x < width; x++) {
      const rawX = rect.x + ((x + 0.5) * rect.width) / width
      const worldX = ((rawX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
      const key = `${Math.floor(worldX / span)}/${Math.floor(worldY / span)}`
      const points = samples.get(key) ?? []
      points.push([
        (y * width + x) * 4,
        (Math.floor(((worldY % span) / span) * OSM_TILE_SIZE) * OSM_TILE_SIZE +
          Math.floor(((worldX % span) / span) * OSM_TILE_SIZE)) *
          4,
      ])
      samples.set(key, points)
    }
  }
  const rgba = new Uint8Array(width * height * 4)
  for (const [key, points] of samples) {
    const [x, y] = key.split('/').map(Number)
    const tile = decode(await read(z, x, y))
    if (tile.width !== OSM_TILE_SIZE || tile.height !== OSM_TILE_SIZE)
      throw new Error('Unexpected OpenStreetMap tile dimensions')
    const data = tile.palette ? convertIndexedToRgb(tile) : tile.data
    const channels = tile.palette?.[0].length ?? tile.channels
    for (const [target, source] of points) {
      const pixel = source / 4
      if (!tile.palette && tile.depth < 8) {
        const perByte = 8 / tile.depth
        const mask = (1 << tile.depth) - 1
        const gray =
          (((data[Math.floor(pixel / perByte)] >>
            ((perByte - 1 - (pixel % perByte)) * tile.depth)) &
            mask) *
            255) /
          mask
        rgba.set([gray, gray, gray, 255], target)
        continue
      }
      const offset = pixel * channels
      const divisor = !tile.palette && tile.depth === 16 ? 257 : 1
      for (let channel = 0; channel < 3; channel++)
        rgba[target + channel] = data[offset + (channels < 3 ? 0 : channel)] / divisor
      rgba[target + 3] =
        channels === 2 || channels === 4 ? data[offset + channels - 1] / divisor : 255
    }
  }
  return rgba
}
