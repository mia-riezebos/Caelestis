import { Hono } from 'hono'
import {
  createAccessToken,
  listAccessTokens,
  parseTokenCursor,
  revokeAccessToken,
} from '../auth/administration.js'
import { requireRuntimeScope } from '../auth/middleware.js'
import { SCOPES, type Scope } from '../auth/tokens.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'

const MAX_LABEL_LENGTH = 128
const BOOTSTRAP_HASH = 'bootstrap'

const isScope = (value: unknown): value is Scope =>
  typeof value === 'string' && (SCOPES as readonly string[]).includes(value)

/**
 * Token administration.
 *
 * Admin-only throughout: a `report` holder that could mint itself `admin` would make the scope
 * ladder decorative.
 *
 * @see .scratch/v1/issues/03-auth-model.md
 */
export const createTokenRoutes = (runtime: BackendRuntime) => {
  const routes = new Hono()

  routes.use('/*', requireRuntimeScope(runtime, 'admin'))

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)

    const { label, scope } = body as { label?: unknown; scope?: unknown }
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return c.json({ error: 'label must be 1..128 characters' }, 400)
    }
    if (!isScope(scope)) return c.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, 400)

    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      createAccessToken({
        label,
        scope,
        // The bootstrap operator has no row of its own, so it is named rather than referenced.
        createdWithToken: caller.token?.tokenHash ?? 'bootstrap',
      }),
      // The only time the plaintext exists outside the caller's hands. Later reads return the hash.
      (created) => c.json(created, 201),
    )
  })

  routes.get('/', async (c) => {
    const cursor = parseTokenCursor(c.req.query('cursor'))
    if (cursor === null) return c.json({ error: 'cursor is invalid' }, 400)
    return runBackendHttp(c, runtime, listAccessTokens(cursor), (page) => c.json(page))
  })

  routes.delete('/:tokenHash', async (c) => {
    const tokenHash = c.req.param('tokenHash')
    // The bootstrap credential lives in the deployment environment, not in this store.
    if (tokenHash === BOOTSTRAP_HASH) {
      return c.json({ error: 'the bootstrap token is set in the environment; unset it there' }, 400)
    }
    // 204 whether or not the row was there. Absence *is* revocation, so a caller that finds the
    // token already gone has the outcome it asked for — 404 on a retry after a lost response
    // reported failure for a request that had succeeded, which made the HTTP contract
    // non-idempotent even though both adapters' `revokeAccessToken` is.
    //
    // It also removes an existence oracle: 404-versus-200 told an admin whether a hash it does not
    // hold exists. Admin-gated, so minor, but free to close.
    return runBackendHttp(c, runtime, revokeAccessToken(tokenHash), () => c.body(null, 204))
  })

  return routes
}
