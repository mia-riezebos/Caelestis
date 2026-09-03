import type {
  AlarmsResponse,
  CanvasTilesResponse,
  ContributionsResponse,
  HistoryResponse,
  LeaderboardResponse,
  Manifest,
  ServerInfo,
  StatusResponse,
  TileHistoryResponse,
} from '@caelestis/shared'
import { frontendClientAccept } from './client-metrics.js'
import { isServerUrlConfigured, resolveSelectedServerUrl, resolveServerUrl } from './server-url.js'

/**
 * A configured server is fixed for the deployment. Without one, the selected server and access
 * token live in localStorage.
 */
const SERVER_KEY = 'caelestis:server'
const TOKEN_KEY = 'caelestis:token'
const API_VERSION_PATH = '/v1'
type ApiVersionPath = typeof API_VERSION_PATH | ''
let apiVersionPath: ApiVersionPath = API_VERSION_PATH
const configuredServer = import.meta.env.VITE_CAELESTIS_SERVER as string | undefined

export const serverUrlIsConfigured = isServerUrlConfigured(configuredServer)

export const readServerUrl = (): string =>
  resolveServerUrl(
    configuredServer,
    localStorage.getItem(SERVER_KEY),
    import.meta.env.DEV,
    window.location.origin,
  )

export const readToken = (): string | null => localStorage.getItem(TOKEN_KEY)

/** Use the SSR Worker credential only for its configured/default server and never for user choices. */
export const usesServerReadProxy = (): boolean =>
  readToken() === null &&
  (serverUrlIsConfigured ||
    localStorage.getItem(SERVER_KEY) === null ||
    readServerUrl() === `${window.location.origin.replace(/\/+$/, '')}/backend`)

export const writeConnection = (url: string, token: string | null): void => {
  if (!serverUrlIsConfigured) localStorage.setItem(SERVER_KEY, resolveSelectedServerUrl(url))
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

const retryableMethod = (method: string | undefined): boolean =>
  method === undefined || method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD'

const transientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

/** One transient edge/backend failure must not strand the app until the user reloads it. */
const fetchWithTransientRetry = async (url: string, init: RequestInit): Promise<Response> => {
  let first: Response
  try {
    first = await fetch(url, init)
  } catch (error) {
    if (!retryableMethod(init.method)) throw error
    return fetch(url, init)
  }
  if (!retryableMethod(init.method) || !transientStatus(first.status)) return first
  return fetch(url, init)
}

const request = async (
  path: string,
  init?: RequestInit,
  versionPath: ApiVersionPath = apiVersionPath,
): Promise<Response> => {
  const token = readToken()
  const proxy = usesServerReadProxy()
  const headers = new Headers(init?.headers)
  const reconciles =
    path === '/manifest' ||
    path.startsWith('/manifest?') ||
    path === '/telemetry/status' ||
    path.startsWith('/telemetry/status?') ||
    path === '/telemetry/alarms' ||
    path.startsWith('/telemetry/alarms?')
  headers.set(
    'accept',
    reconciles ? frontendClientAccept('recovery', 'connect') : frontendClientAccept(),
  )
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  const endpoint = proxy ? `/api${versionPath}${path}` : `${readServerUrl()}${versionPath}${path}`
  const response = await fetchWithTransientRetry(endpoint, { ...init, headers })
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

const json = async <T>(path: string, versionPath?: ApiVersionPath): Promise<T> =>
  (await request(path, undefined, versionPath)).json() as Promise<T>

export const getServer = async (): Promise<ServerInfo> => {
  apiVersionPath = API_VERSION_PATH
  try {
    return await json('/server', API_VERSION_PATH)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error
  }
  const server = await json<ServerInfo>('/server', '')
  apiVersionPath = ''
  return server
}

export const getManifest = (season?: number): Promise<Manifest> =>
  json(season === undefined ? '/manifest' : `/manifest?season=${season}`)

export const getStatus = (season?: number): Promise<StatusResponse> =>
  json(season === undefined ? '/telemetry/status' : `/telemetry/status?season=${season}`)

export const getAlarms = (season?: number): Promise<AlarmsResponse> =>
  json(season === undefined ? '/telemetry/alarms' : `/telemetry/alarms?season=${season}`)

/** `/server` deliberately exposes no caller scope, so admin admission is probed explicitly. */
export const probeAdminScope = async (season: number): Promise<boolean> => {
  try {
    await request(`/admin/nodes?season=${season}`)
    return true
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
    throw error
  }
}

export const patchTemplateLifecycle = async (
  templateId: string,
  patch: { readonly finished?: boolean; readonly timelapseFrozen?: boolean },
): Promise<void> => {
  await request(`/admin/templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export const getHistory = (
  templateIds: readonly string[],
  from: number,
  to: number,
  options: { readonly maxResolution?: number } = {},
): Promise<HistoryResponse> =>
  json(
    `/telemetry/history?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&from=${from}&to=${to}` +
      (options.maxResolution === undefined ? '' : `&maxResolution=${options.maxResolution}`),
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
  from: number,
  to: number,
): Promise<TileHistoryResponse> =>
  json(`/telemetry/tiles/${x}/${y}/history?season=${season}&from=${from}&to=${to}`)

/**
 * Authenticated image loading.
 *
 * `/chunks` and `/tiles` require a bearer token, which an `<img src>` cannot carry. Fetch each image
 * as a blob and return an object URL. Content hashes make cache invalidation unnecessary.
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
