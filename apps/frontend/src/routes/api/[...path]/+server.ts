import { fetchBackend } from '$lib/server/backend.js'
import type { RequestHandler } from './$types'

const proxyRead: RequestHandler = async (event) => {
  const path = event.params.path
  if (path === undefined || path.length === 0) return new Response(null, { status: 404 })
  const headers = new Headers()
  for (const name of ['accept', 'if-none-match', 'range']) {
    const value = event.request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  try {
    const response = await fetchBackend(event, `${path}${event.url.search}`, {
      method: event.request.method,
      headers,
    })
    return new Response(response.body, response)
  } catch (error) {
    console.error('frontend backend proxy failed', error)
    return Response.json({ error: 'template server unavailable' }, { status: 502 })
  }
}

export const GET = proxyRead
export const HEAD = proxyRead
