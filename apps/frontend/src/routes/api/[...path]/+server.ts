import { fetchBackend } from '$lib/server/backend.js'
import type { RequestHandler } from './$types'

const proxyRead: RequestHandler = async (event) => {
  const path = event.params.path
  if (path === undefined || path.length === 0) return new Response(null, { status: 404 })
  const headers = new Headers()
  const upgrade = event.request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  for (const name of [
    'accept',
    'if-none-match',
    'range',
    ...(upgrade ? ['upgrade', 'connection', 'sec-websocket-protocol'] : []),
  ]) {
    const value = event.request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  try {
    const response = await fetchBackend(event, `${path}${event.url.search}`, {
      method: event.request.method,
      headers,
    })
    if (upgrade) return response
    // The body below is whatever `fetch` handed back, which is already decoded, so the backend's
    // transfer headers no longer describe it. Under Node's fetch in `vite dev` a forwarded
    // `content-encoding: gzip` made every browser read fail with a decoding error; on Workers the
    // runtime re-encodes for the client either way.
    const proxied = new Headers(response.headers)
    proxied.delete('content-encoding')
    proxied.delete('content-length')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxied,
    })
  } catch (error) {
    console.error('frontend backend proxy failed', error)
    return Response.json({ error: 'template server unavailable' }, { status: 502 })
  }
}

export const GET = proxyRead
export const HEAD = proxyRead
