import {
  type ServerInfo,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { requireRuntimeScope } from '../auth/middleware.js'
import { assembleManifestEffect } from '../manifest/assemble.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { resolveServerInfoEffect } from './server.js'

// Wplace's first and current canvas is season 0; later seasons increment from there.
const SEASON_NUMBER = /^(?:0|[1-9]\d*)$/
const POSITIVE_NUMBER = /^[1-9]\d*$/

const parseSeason = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined) return fallback
  if (!SEASON_NUMBER.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parseSurface = (
  kind: string | undefined,
  allianceId: string | undefined,
): TemplateSurface | null => {
  if (kind === undefined && allianceId === undefined) return WORLD_TEMPLATE_SURFACE
  if (kind === 'world') return allianceId === undefined ? WORLD_TEMPLATE_SURFACE : null
  if (kind === undefined || allianceId === undefined || !POSITIVE_NUMBER.test(allianceId))
    return null
  const parsedAllianceId = Number(allianceId)
  return Number.isSafeInteger(parsedAllianceId) ? templateSurface(kind, parsedAllianceId) : null
}

export const createManifestRoutes = (
  runtime: BackendRuntime,
  options: { readonly server: ServerInfo; readonly currentSeason: number },
) => {
  const routes = new Hono()

  routes.use('/*', requireRuntimeScope(runtime, 'read'))

  routes.get('/', async (c) => {
    const season = parseSeason(c.req.query('season'), options.currentSeason)
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) {
      return c.json(
        { error: 'surface must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }

    return runBackendHttp(
      c,
      runtime,
      Effect.gen(function* () {
        // Resolved rather than configured: a rename must update both `/server` and the tree label.
        const server = yield* resolveServerInfoEffect(options.server)
        return yield* assembleManifestEffect({
          server,
          season,
          surface,
          includeUnpublished: c.get('caller').scope === 'admin',
        })
      }),
      (manifest) => {
        const etag = `"${manifest.version}"`
        const headers = { ETag: etag, Vary: 'Authorization' }
        // RFC 9110 allows comma-separated and weak validators; manifest hashes use weak comparison.
        const candidates = (c.req.header('if-none-match') ?? '')
          .split(',')
          .map((candidate) => candidate.trim().replace(/^W\//, ''))
        if (candidates.includes(etag) || candidates.includes('*')) {
          return c.body(null, 304, headers)
        }
        return c.json(manifest, 200, headers)
      },
    )
  })

  return routes
}
