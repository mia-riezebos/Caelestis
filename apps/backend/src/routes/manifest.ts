import type { ServerInfo } from '@wts/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import { assembleManifest } from '../manifest/assemble.js'
import type { Ports } from '../ports/index.js'
import { resolveServerInfo } from './server.js'

// Seasons are 1-based, matching `Season` in the wire and the Worker's own `SEASON` refusal.
const SEASON_NUMBER = /^[1-9]\d*$/

const parseSeason = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined) return fallback
  if (!SEASON_NUMBER.test(value)) return null
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
    if (season === null) return c.json({ error: 'season must be a positive integer' }, 400)

    const manifest = await assembleManifest(ports, {
      // Resolved rather than the configured value: the manifest carries the server's name too, and
      // a rename that showed up on `/server` but not here would leave the tree labelled with the
      // old one — which is exactly where anyone would look to check the rename worked.
      server: await resolveServerInfo(ports, options.server),
      season,
      includeUnpublished: c.get('caller').scope === 'admin',
    })
    const etag = `"${manifest.version}"`
    const headers = { ETag: etag, Vary: 'Authorization' }
    // RFC 9110 lets If-None-Match carry a comma-separated list and mark each entry weak with `W/`.
    // An exact string compare therefore missed a conforming client entirely: send two etags, or one
    // a cache has weakened, and you never get a 304 again. Weak comparison is the right one here —
    // the manifest is a content hash, so a weak and a strong tag over the same bytes mean the same.
    const candidates = (c.req.header('if-none-match') ?? '')
      .split(',')
      .map((candidate) => candidate.trim().replace(/^W\//, ''))
    if (candidates.includes(etag) || candidates.includes('*')) {
      return c.body(null, 304, headers)
    }
    return c.json(manifest, 200, headers)
  })

  return routes
}
