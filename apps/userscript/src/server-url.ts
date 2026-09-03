const DEFAULT_SERVER_BASE_PATH = '/backend'
const API_VERSION_PATH = '/v1'
export type ServerApiVersion = 'v1' | 'legacy'

const serverApiVersions = new Map<string, ServerApiVersion>()

export const canonicalServerUrl = (value: string): string => {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('server URL must use HTTP or HTTPS')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('server URL must not contain credentials')
  }
  parsed.search = ''
  parsed.hash = ''
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path}`
}

/**
 * Resolve one backend route without changing the configured server's identity.
 *
 * An origin-only address uses Caelestis' conventional `/backend` mount. A path supplied by the
 * operator is already a base path and replaces that default, which keeps self-hosted deployments
 * free to mount the same backend wherever their host layout requires.
 */
export const rememberServerApiVersion = (serverUrl: string, version: ServerApiVersion): void => {
  serverApiVersions.set(canonicalServerUrl(serverUrl), version)
}

export const serverEndpoint = (
  serverUrl: string,
  route: string,
  version?: ServerApiVersion,
): string => {
  const base = canonicalServerUrl(serverUrl)
  const path = route.startsWith('/') ? route : `/${route}`
  const apiPath = (version ?? serverApiVersions.get(base) ?? 'v1') === 'v1' ? API_VERSION_PATH : ''
  return `${base}${new URL(base).pathname === '/' ? DEFAULT_SERVER_BASE_PATH : ''}${apiPath}${path}`
}
