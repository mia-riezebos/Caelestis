export const isServerUrlConfigured = (configured: string | undefined): configured is string =>
  configured !== undefined && configured.length > 0

export const resolveSelectedServerUrl = (selected: string): string => {
  const server = selected.replace(/\/+$/, '')
  return server.endsWith('/backend') ? server : `${server}/backend`
}

export const resolveServerUrl = (
  configured: string | undefined,
  stored: string | null,
  dev: boolean,
  origin: string,
): string => {
  if (isServerUrlConfigured(configured)) return configured.replace(/\/+$/, '')
  if (stored !== null && stored.length > 0) return resolveSelectedServerUrl(stored)
  return `${dev ? 'http://127.0.0.1:8787' : origin.replace(/\/+$/, '')}/backend`
}
