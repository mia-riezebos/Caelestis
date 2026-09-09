import type { CanvasTilesResponse, Template } from '@caelestis/shared'
import type { RequestEvent } from '@sveltejs/kit'
import { fetchMapTile, MAP_CACHE_MS, type ReadMapTile } from '$lib/social-basemap.js'
import { socialImageKey } from '$lib/social-image.js'
import { renderTemplateHistory, renderTimelapse } from '$lib/social-render.js'
import { fetchBackend } from './backend.js'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const refreshing = new Map<string, Promise<void>>()
type ImageEvent = Pick<RequestEvent, 'fetch' | 'platform' | 'url'>

/** Persist a first artwork GIF and refresh history while continuing to serve the previous object. */
export const ensureSocialImage = async (event: ImageEvent, season: number, template: Template) => {
  const images = event.platform?.env.SOCIAL_IMAGES
  if (images === undefined) return null
  const key = socialImageKey(season, template)
  const readMapTile: ReadMapTile = async (z, x, y) => {
    const mapKey = `social/osm/${z}/${x}/${y}.png`
    const cached = await images.get(mapKey)
    if (cached && Date.now() - cached.uploaded.getTime() < MAP_CACHE_MS)
      return new Uint8Array(await cached.arrayBuffer())
    if (cached) await cached.body.cancel()
    const bytes = await fetchMapTile(z, x, y)
    await images.put(mapKey, bytes, { httpMetadata: { contentType: 'image/png' } })
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
  const missing = image === null
  if (missing) {
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
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'image/gif' },
        customMetadata: { version: template.version },
      })) ?? (await images.head(key))
  }
  if (image === null) throw new Error(`Could not persist preview for ${template.id}`)
  const stale =
    Date.now() - image.uploaded.getTime() >= REFRESH_AFTER_MS ||
    (image.customMetadata?.version !== undefined &&
      image.customMetadata.version !== template.version)
  const ctx = event.platform?.ctx
  if (ctx && (missing || stale)) {
    const refreshKey = `${event.url.origin}/${key}`
    let pending = refreshing.get(refreshKey)
    if (pending === undefined) {
      const etag = image.etag
      pending = (async () => {
        const canvas: CanvasTilesResponse = await (
          await read(`telemetry/canvas?season=${season}`)
        ).json()
        const gif = await renderTemplateHistory(
          template,
          season,
          new Map(canvas.tiles.map((tile) => [tile.tile, tile.hash])),
          read,
          readMapTile,
        )
        if (gif === null) return
        await images.put(key, gif, {
          onlyIf: { etagMatches: etag },
          httpMetadata: { contentType: 'image/gif' },
          customMetadata: { version: template.version },
        })
      })()
        .catch((error: unknown) => {
          console.error('social image refresh failed; keeping the previous GIF', error)
        })
        .finally(() => refreshing.delete(refreshKey))
      refreshing.set(refreshKey, pending)
    }
    ctx.waitUntil(pending)
  }
  return image
}
