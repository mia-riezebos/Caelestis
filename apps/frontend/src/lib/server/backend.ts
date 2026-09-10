import type { RequestEvent } from '@sveltejs/kit'
import { frontendClientAccept } from '$lib/api/client-metrics.js'

type BackendEvent = Pick<RequestEvent, 'fetch' | 'platform' | 'url'> & { locals?: App.Locals }

const environment = (event: BackendEvent) => event.locals?.backendEnvironment ?? event.platform?.env

const readToken = (event: BackendEvent): string => {
  const token = environment(event)?.CAELESTIS_READ_TOKEN?.trim()
  if (token === undefined || token.length === 0) {
    throw new Error('frontend is missing CAELESTIS_READ_TOKEN')
  }
  return token
}

/** Fetch one backend read without exposing the frontend Worker's credential to the browser. */
export const fetchBackend = (
  event: BackendEvent,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const configuredBase =
    environment(event)?.CAELESTIS_SERVER ?? import.meta.env.VITE_CAELESTIS_SERVER
  const base = (configuredBase ?? new URL('/backend', event.url).href).replace(/\/+$/, '')
  const headers = new Headers(init.headers)
  headers.delete('cookie')
  headers.set('authorization', `Bearer ${readToken(event)}`)
  if (!headers.has('accept')) headers.set('accept', frontendClientAccept('recovery', 'connect'))
  const target = `${base}/${path.replace(/^\/+/, '')}`
  const requestInit = { ...init, headers }
  const backend = environment(event)?.CAELESTIS_BACKEND
  if (configuredBase === undefined && backend !== undefined) {
    return backend.fetch(new Request(target, requestInit))
  }
  return event.fetch(target, requestInit)
}

export const readBackendJson = async <T>(event: BackendEvent, path: string): Promise<T> => {
  const response = await fetchBackend(event, path)
  if (!response.ok) throw new Error(`backend read failed with HTTP ${response.status}`)
  return response.json() as Promise<T>
}
