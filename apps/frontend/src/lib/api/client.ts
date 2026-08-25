import type {
  CanvasTilesResponse,
  ContributionsResponse,
  HistoryResponse,
  LeaderboardResponse,
  Manifest,
  ServerInfo,
  StatusResponse,
  TileHistoryResponse,
} from '@caelestis/shared'
import { resolveServerUrl } from './server-url.js'

/**
 * The template server the dashboard reads from.
 *
 * A deployment fronts exactly one server — `VITE_CAELESTIS_SERVER` at build time, the page's own
 * origin plus `/backend` otherwise, wrangler's port plus `/backend` in dev. Deliberately not
 * user-configurable: whoever is on this frontend is here for this server. Only the access token is
 * theirs, and it lives in localStorage.
 */
const TOKEN_KEY = 'caelestis:token'

export const serverUrl = ((): string => {
  const configured = import.meta.env.VITE_CAELESTIS_SERVER as string | undefined
  return resolveServerUrl(configured, import.meta.env.DEV, window.location.origin)
})()

export const readToken = (): string | null => localStorage.getItem(TOKEN_KEY)

export const writeToken = (token: string | null): void => {
  if (token === null || token.length === 0) localStorage.removeItem(TOKEN_KEY)
  else localStorage.setItem(TOKEN_KEY, token)
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const token = readToken()
  const headers = new Headers(init?.headers)
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: string }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // A non-JSON error body keeps the status text.
    }
    throw new ApiError(response.status, message)
  }
  return response
}

const json = async <T>(path: string): Promise<T> => (await request(path)).json() as Promise<T>

export const getServer = (): Promise<ServerInfo> => json('/server')

export const getManifest = (season?: number): Promise<Manifest> =>
  json(season === undefined ? '/manifest' : `/manifest?season=${season}`)

export const getStatus = (season?: number): Promise<StatusResponse> =>
  json(season === undefined ? '/telemetry/status' : `/telemetry/status?season=${season}`)

export const getHistory = (
  templateIds: readonly string[],
  resolution: number,
  from: number,
  to: number,
): Promise<HistoryResponse> =>
  json(
    `/telemetry/history?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&resolution=${resolution}&from=${from}&to=${to}`,
  )

export const getContributions = (
  templateIds: readonly string[],
  from: number,
  to: number,
): Promise<ContributionsResponse> =>
  json(
    `/telemetry/contributions?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&from=${from}&to=${to}`,
  )

export const getLeaderboard = (
  season: number,
  options: { templateIds?: readonly string[]; from?: number; to?: number; limit?: number } = {},
): Promise<LeaderboardResponse> => {
  const params = new URLSearchParams({ season: String(season) })
  if (options.templateIds !== undefined) params.set('templateIds', options.templateIds.join(','))
  if (options.from !== undefined) params.set('from', String(options.from))
  if (options.to !== undefined) params.set('to', String(options.to))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return json(`/telemetry/leaderboard?${params}`)
}

export const getCanvas = (season: number): Promise<CanvasTilesResponse> =>
  json(`/telemetry/canvas?season=${season}`)

export const getTileHistory = (
  x: number,
  y: number,
  season: number,
  resolution: number,
  from: number,
  to: number,
): Promise<TileHistoryResponse> =>
  json(
    `/telemetry/tiles/${x}/${y}/history?season=${season}&resolution=${resolution}` +
      `&from=${from}&to=${to}`,
  )

/**
 * Authenticated image loading.
 *
 * `/chunks` and `/tiles` require a bearer token, which an `<img src>` cannot carry — so images are
 * fetched as blobs and handed out as object URLs, cached by path. Both namespaces are
 * content-addressed and immutable, so the cache never needs invalidation, only bounding.
 */
const blobCache = new Map<string, Promise<string>>()
const BLOB_CACHE_LIMIT = 512

export const loadImageUrl = (path: string): Promise<string> => {
  const cached = blobCache.get(path)
  if (cached !== undefined) return cached
  const url = request(path)
    .then(async (response) => URL.createObjectURL(await response.blob()))
    .catch((error) => {
      blobCache.delete(path)
      throw error
    })
  if (blobCache.size >= BLOB_CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value
    if (oldest !== undefined) {
      blobCache.get(oldest)?.then(URL.revokeObjectURL, () => {})
      blobCache.delete(oldest)
    }
  }
  blobCache.set(path, url)
  return url
}

export const chunkImageUrl = (hash: string): Promise<string> => loadImageUrl(`/chunks/${hash}`)
export const tileImageUrl = (hash: string): Promise<string> => loadImageUrl(`/tiles/${hash}`)
