import {
  CLIENT_KIND_QUERY,
  CLIENT_VERSION_QUERY,
  SYNC_MODE_QUERY,
  SYNC_REASON_QUERY,
  SYNC_TRANSPORT_QUERY,
  type SyncRequestMetadata,
  syncRequestHeaders,
} from '@caelestis/shared'

declare const __CAELESTIS_VERSION__: string

export const userscriptVersion =
  typeof __CAELESTIS_VERSION__ === 'string' ? __CAELESTIS_VERSION__ : 'development'

/** Add identity-free observability dimensions without replacing authentication or content headers. */
export const userscriptRequestHeaders = (
  headers?: HeadersInit,
  metadata?: SyncRequestMetadata,
): Headers => {
  const result = new Headers(headers)
  for (const [name, value] of Object.entries(
    syncRequestHeaders('userscript', userscriptVersion, metadata),
  )) {
    result.set(name, value)
  }
  return result
}

const SIMPLE_READ_HEADERS = new Set(['accept', 'accept-language', 'content-language'])

/**
 * Carry dimensions in the query for otherwise-simple reads, preserving their no-preflight CORS
 * behavior. Requests that already need a preflight use headers and keep cache URLs unchanged.
 */
export const observedUserscriptRequest = (
  input: string,
  init: RequestInit = {},
  metadata?: SyncRequestMetadata,
): { readonly input: string; readonly init: RequestInit } => {
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  const simpleRead =
    (method === 'GET' || method === 'HEAD') &&
    [...headers.keys()].every((name) => SIMPLE_READ_HEADERS.has(name.toLowerCase()))
  if (!simpleRead) {
    return { input, init: { ...init, headers: userscriptRequestHeaders(headers, metadata) } }
  }
  const url = new URL(input)
  const dimensions = syncRequestHeaders('userscript', userscriptVersion, metadata)
  url.searchParams.set(CLIENT_KIND_QUERY, dimensions['x-caelestis-client'] ?? 'userscript')
  url.searchParams.set(
    CLIENT_VERSION_QUERY,
    dimensions['x-caelestis-client-version'] ?? userscriptVersion,
  )
  url.searchParams.set(SYNC_TRANSPORT_QUERY, dimensions['x-caelestis-sync-transport'] ?? 'http')
  url.searchParams.set(SYNC_MODE_QUERY, dimensions['x-caelestis-sync-mode'] ?? 'none')
  url.searchParams.set(SYNC_REASON_QUERY, dimensions['x-caelestis-sync-reason'] ?? 'none')
  return { input: url.toString(), init: { ...init, headers } }
}
