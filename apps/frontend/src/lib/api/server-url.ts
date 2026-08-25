export const resolveServerUrl = (
  configured: string | undefined,
  dev: boolean,
  origin: string,
): string => {
  if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/, '')
  return `${dev ? 'http://127.0.0.1:8787' : origin.replace(/\/+$/, '')}/backend`
}
