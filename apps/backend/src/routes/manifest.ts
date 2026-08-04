import type { ServerInfo } from '@wts/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import { assembleManifest } from '../manifest/assemble.js'
import type { Ports } from '../ports/index.js'

const WHOLE_NUMBER = /^(0|[1-9]\d*)$/

const parseSeason = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined) return fallback
  if (!WHOLE_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export const createManifestRoutes = (
  ports: Pick<Ports, 'sql'>,
  auth: AuthOptions,
  options: { readonly server: ServerInfo; readonly currentSeason: number },
) => {
  const routes = new Hono()

  routes.use('/*', requireScope(auth, 'read'))

  routes.get('/', async (c) => {
    const season = parseSeason(c.req.query('season'), options.currentSeason)
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)

    const manifest = await assembleManifest(ports, {
      server: options.server,
      season,
      includeUnpublished: c.get('caller').scope === 'admin',
    })
    const etag = `"${manifest.version}"`
    const headers = { ETag: etag, Vary: 'Authorization' }
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
    return c.json(manifest, 200, headers)
  })

  return routes
}
