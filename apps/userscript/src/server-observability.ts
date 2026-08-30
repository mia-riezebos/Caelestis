import { type SyncRequestMetadata, syncRequestHeaders } from '@caelestis/shared'

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
