import type { ServerInfo } from '@caelestis/shared'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import {
  type BackendRuntime,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { BackendStorageError, SqlStoreReadError } from '../runtime/errors.js'
import { runBackendHttp } from '../runtime/hono.js'
import { publishManifestChange } from '../status-read-model/port.js'

const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 4096

/**
 * What this server calls itself, as the deployment configured it and an admin has since renamed it.
 *
 * Resolved per request rather than fixed at start-up, because a rename has to take effect without a
 * redeploy — the whole point of moving it out of `[vars]`. The vars stay the value a fresh
 * deployment begins with; anything set here wins for as long as it is set.
 */
const mergeServerInfo = (
  base: ServerInfo,
  settings: { readonly name: string | null; readonly description: string | null },
): ServerInfo => {
  const description = settings.description ?? base.description
  const resolved = {
    id: base.id,
    name: settings.name ?? base.name,
    auth: base.auth,
    ...(base.liveSync === undefined ? {} : { liveSync: base.liveSync }),
  }
  return description === undefined || description === null ? resolved : { ...resolved, description }
}

export const resolveServerInfoEffect = (
  base: ServerInfo,
): Effect.Effect<ServerInfo, SqlStoreReadError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const settings = yield* Effect.tryPromise({
      try: () => sql.readServerSettings(),
      catch: (cause) => new SqlStoreReadError({ operation: 'readServerSettings', cause }),
    })
    return mergeServerInfo(base, settings)
  })

export const writeServerSettings = (settings: {
  readonly name?: string
  readonly description?: string | null
}): Effect.Effect<void, BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    yield* Effect.tryPromise({
      try: () => sql.writeServerSettings(settings),
      catch: (cause) => new BackendStorageError({ operation: 'writeServerSettings', cause }),
    })
  })

const writeServerSettingsAndPublish = (
  settings: Parameters<typeof writeServerSettings>[0],
  season: number,
): Effect.Effect<void, BackendStorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    yield* writeServerSettings(settings)
    const statusReadModel = yield* StatusReadModelService
    yield* Effect.promise(() => publishManifestChange(statusReadModel, season))
  })

export const createServerRoutes = (runtime: BackendRuntime, base: ServerInfo) => {
  const routes = new Hono()
  // Public, and deliberately so: this is how a userscript decides whether it needs a token at all.
  routes.get('/', (c) =>
    runBackendHttp(c, runtime, resolveServerInfoEffect(base), (server) => c.json(server)),
  )
  return routes
}

/**
 * Renaming the server.
 *
 * Its own route under `/admin` rather than a method on the public one, so the read stays reachable
 * without a credential while the write never is.
 */
export const createServerAdminRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  currentSeason: number,
) => {
  const routes = new Hono()

  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))

  routes.patch('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)
    const { name, description } = body as { name?: unknown; description?: unknown }

    if (
      name !== undefined &&
      (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME_LENGTH)
    ) {
      return c.json({ error: 'name must be 1..256 characters' }, 400)
    }
    // Null clears it, which is not the same as leaving it alone: one goes back to whatever the
    // deployment configured, the other keeps whatever an admin set earlier.
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== 'string' ||
        description.trim().length === 0 ||
        description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return c.json({ error: 'description must be 1..4096 characters, or null' }, 400)
    }
    if (name === undefined && description === undefined) {
      return c.json({ error: 'patch must set at least one of name, description' }, 400)
    }

    return runBackendHttp(
      c,
      runtime,
      writeServerSettingsAndPublish(
        {
          ...(name === undefined ? {} : { name: (name as string).trim() }),
          ...(description === undefined
            ? {}
            : { description: description === null ? null : (description as string) }),
        },
        currentSeason,
      ),
      () => c.json({ ok: true }),
    )
  })

  return routes
}
