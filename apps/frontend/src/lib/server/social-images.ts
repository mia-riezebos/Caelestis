import type { Template } from '@caelestis/shared'
import type { RequestEvent } from '@sveltejs/kit'
import { fetchMapTile, MAP_CACHE_MS, type ReadMapTile } from '$lib/social-basemap.js'
import { socialImageKey } from '$lib/social-image.js'
import { renderTimelapse } from '$lib/social-render.js'
import { fetchBackend } from './backend.js'
import { imageStorageFor } from './image-storage.js'

type ImageEvent = Pick<RequestEvent, 'fetch' | 'platform' | 'url'> & { locals?: App.Locals }

/** Persist a first artwork GIF; the scheduled job replaces it with rendered history. */
export const ensureSocialImage = async (event: ImageEvent, season: number, template: Template) => {
  const images = imageStorageFor(event)
  if (images === undefined) return null
  const key = socialImageKey(season, template)
  const readMapTile: ReadMapTile = async (z, x, y) => {
    const mapKey = `social/osm/${z}/${x}/${y}.png`
    const cached = await images.get(mapKey)
    if (cached && Date.now() - cached.uploadedAt < MAP_CACHE_MS) return cached.bytes
    const bytes = await fetchMapTile(z, x, y)
    await images.put(mapKey, bytes, { contentType: 'image/png' })
    return bytes
  }
  const read = async (path: string) => {
    const response = await fetchBackend(event, `/v1/${path}`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  let image = await images.head(key)
  if (image === null) {
    const poster = await renderTimelapse({
      template: { ...template, finished: false },
      histories: new Map(),
      artwork: true,
      readMapTile,
      canvas: new Map(template.chunks.map((chunk) => [chunk.tile, chunk.hash])),
      readTile: async (hash) => new Uint8Array(await (await read(`chunks/${hash}`)).arrayBuffer()),
    })
    if (poster === null) throw new Error(`Template ${template.id} has no artwork for its first GIF`)
    // A concurrent renderer may have already stored a full timelapse. Never overwrite it with a poster.
    image =
      (await images.put(key, poster, {
        ifAbsent: true,
        contentType: 'image/gif',
        metadata: { version: template.version },
      })) ?? (await images.head(key))
  }
  if (image === null) throw new Error(`Could not persist preview for ${template.id}`)
  return image
}
