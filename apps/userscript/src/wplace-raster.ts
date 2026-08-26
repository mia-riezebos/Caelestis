import { parseTileKey, type TileCoord } from '@caelestis/shared'
import { isPageInstance } from './page-world.js'

export type WplaceRasterRole = 'tile' | 'draft' | 'other'

export const wplaceRasterRole = (layerId: string | null): WplaceRasterRole => {
  if (layerId === 'pixel-art-layer') return 'tile'
  if (layerId?.startsWith('paint-preview-')) return 'draft'
  return 'other'
}

const TILE_PATH = /^\/files\/s\d+\/tiles\/(\d+)\/(\d+)\.png$/
const TILE_ORIGIN = 'https://backend.wplace.live'
const TRANSPARENT_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 96, 96, 0, 0, 0, 3, 0, 1, 43, 9, 77,
  132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

/** Accept only canonical tile paths on Wplace's tile origin. */
export const tileFromUrl = (url: string): TileCoord | null => {
  let parsed: URL
  try {
    parsed = new URL(url, typeof location === 'undefined' ? TILE_ORIGIN : location.href)
  } catch {
    return null
  }
  if (parsed.origin !== TILE_ORIGIN) return null
  const match = TILE_PATH.exec(parsed.pathname)
  return match === null ? null : parseTileKey(`${match[1]}/${match[2]}`)
}

export interface FetchUrlGetters {
  readonly requestUrl: ((this: Request) => string) | undefined
  readonly requestMethod: ((this: Request) => string) | undefined
  readonly urlHref: ((this: URL) => string) | undefined
  readonly urlPrototype: object | undefined
  readonly urlToString: ((this: URL) => string) | undefined
}

/** Snapshot native URL readers before page code or another userscript can replace them. */
export const captureFetchUrlGetters = (realm: Window & typeof globalThis): FetchUrlGetters => {
  try {
    return {
      requestUrl: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'url')?.get,
      requestMethod: realm.Object.getOwnPropertyDescriptor(realm.Request.prototype, 'method')?.get,
      urlHref: realm.Object.getOwnPropertyDescriptor(realm.URL.prototype, 'href')?.get,
      urlPrototype: realm.URL.prototype,
      urlToString: realm.Object.getOwnPropertyDescriptor(realm.URL.prototype, 'toString')?.value,
    }
  } catch {
    return {
      requestUrl: undefined,
      requestMethod: undefined,
      urlHref: undefined,
      urlPrototype: undefined,
      urlToString: undefined,
    }
  }
}

/** Read a fetch URL without repeating user-controlled conversion. */
export const urlForFetchInput = (
  input: unknown,
  realm: Window & typeof globalThis,
  getters: FetchUrlGetters,
): string | null => {
  if (typeof input === 'string') return input
  try {
    if (isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>))
      return getters.requestUrl?.call(input as Request) ?? null
    if (isPageInstance(input, 'URL', realm as unknown as Record<string, unknown>)) {
      if (getters.urlPrototype === undefined || getters.urlToString === undefined) return null
      if (realm.Object.getPrototypeOf(input) !== getters.urlPrototype) return null
      if (realm.Object.getOwnPropertyDescriptor(input, 'toString') !== undefined) return null
      if (realm.Object.getOwnPropertyDescriptor(input, Symbol.toPrimitive) !== undefined)
        return null
      if (
        realm.Object.getOwnPropertyDescriptor(getters.urlPrototype, Symbol.toPrimitive) !==
        undefined
      )
        return null
      if (
        realm.Object.getOwnPropertyDescriptor(getters.urlPrototype, 'toString')?.value !==
        getters.urlToString
      )
        return null
      return getters.urlHref?.call(input as URL) ?? null
    }
  } catch {
    // Attribution is optional when a proxy or replaced constructor rejects its native slot.
  }
  return null
}

/** Read fetch's effective method without repeating accessors or string conversion. */
export const isGetFetch = (
  input: unknown,
  init: RequestInit | null | undefined,
  realm: Window & typeof globalThis,
  getters: FetchUrlGetters,
): boolean => {
  let method: string | null = null
  try {
    if (
      typeof input === 'string' ||
      isPageInstance(input, 'URL', realm as unknown as Record<string, unknown>)
    )
      method = 'GET'
    else if (isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>))
      method = getters.requestMethod?.call(input as Request) ?? null
    if (method === null || init === undefined || init === null) return method === 'GET'

    let descriptor = realm.Object.getOwnPropertyDescriptor(init, 'method')
    if (descriptor === undefined) {
      const prototype = realm.Object.getPrototypeOf(init)
      if (prototype === null) return method === 'GET'
      if (prototype !== realm.Object.prototype) return false
      descriptor = realm.Object.getOwnPropertyDescriptor(prototype, 'method')
      if (descriptor === undefined) return method === 'GET'
    }
    if (!('value' in descriptor)) return false
    if (descriptor.value === undefined) return method === 'GET'
    return typeof descriptor.value === 'string' && descriptor.value.toUpperCase() === 'GET'
  } catch {
    return false
  }
}

/** Match Wplace's service-worker substitution so absent tiles remain decodable. */
export const normalizeMissingTileResponse = (
  response: Response,
  realm: Window & typeof globalThis,
): Response => {
  if (response.status !== 404) return response
  const substitute = new realm.Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // The substitute does not depend on the original stream.
  }
  return substitute
}
