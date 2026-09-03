import type { RequestEvent } from '@sveltejs/kit'
import { frontendClientAccept } from '$lib/api/client-metrics.js'

type BackendEvent = Pick<RequestEvent, 'fetch' | 'platform' | 'url'>

const backendBase = ({ platform, url }: BackendEvent): string =>
  (platform?.env.CAELESTIS_SERVER ?? new URL('/backend', url).href).replace(/\/+$/, '')

const readToken = ({ platform }: BackendEvent): string => {
  const token = platform?.env.CAELESTIS_READ_TOKEN?.trim()
  if (token === undefined || token.length === 0) {
    throw new Error('frontend Worker is missing CAELESTIS_READ_TOKEN')
  }
  return token
}

/** Fetch one backend read without exposing the frontend Worker's credential to the browser. */
export const fetchBackend = (
  event: BackendEvent,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.delete('cookie')
  headers.set('authorization', `Bearer ${readToken(event)}`)
  if (!headers.has('accept')) headers.set('accept', frontendClientAccept('recovery', 'connect'))
  return event.fetch(`${backendBase(event)}/${path.replace(/^\/+/, '')}`, { ...init, headers })
}

export const readBackendJson = async <T>(event: BackendEvent, path: string): Promise<T> => {
  const response = await fetchBackend(event, path)
  if (!response.ok) throw new Error(`backend read failed with HTTP ${response.status}`)
  return response.json() as Promise<T>
}
