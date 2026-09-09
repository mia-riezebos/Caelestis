import type { Manifest } from '@caelestis/shared'
import { readBackendJson } from '$lib/server/backend.js'
import { DEFAULT_SOCIAL_IMAGE, socialImageKey } from '$lib/social-image.js'
import type { RequestHandler } from './$types'

const serve: RequestHandler = async (event) => {
  try {
    // Check publication on every request, including old links after deletion or unpublication.
    const manifest = await readBackendJson<Manifest>(event, '/v1/manifest')
    const template = manifest.templates.find(
      (entry) => entry.id === event.params.id && entry.published,
    )
    if (template === undefined) return new Response(null, { status: 404 })
    const images = event.platform?.env.SOCIAL_IMAGES
    const key = socialImageKey(manifest.season, template)
    const object = await images?.get(key)
    if (object == null) {
      return new Response(null, {
        status: 302,
        headers: { location: DEFAULT_SOCIAL_IMAGE, 'cache-control': 'no-store' },
      })
    }
    const headers = {
      'content-type': 'image/gif',
      'content-length': String(object.size),
      etag: object.httpEtag,
      // Crawlers cache their own copies. Revalidate ours so publication changes take effect.
      'cache-control': 'public, no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (event.request.headers.get('if-none-match') === object.httpEtag) {
      await object.body.cancel()
      return new Response(null, { status: 304, headers })
    }
    if (event.request.method === 'HEAD') {
      await object.body.cancel()
      return new Response(null, { headers })
    }
    return new Response(await object.arrayBuffer(), { headers })
  } catch (error) {
    console.error('social image read failed', error)
    return new Response(null, { status: 503, headers: { 'retry-after': '60' } })
  }
}

export const GET = serve
export const HEAD = serve
