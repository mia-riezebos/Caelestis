import { millis } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import { hashToken, mintToken, SCOPES, type Scope } from '../auth/tokens.js'
import type { AccessToken } from '../ports/index.js'

const MAX_LABEL_LENGTH = 128

/**
 * The stand-in hash for the operator's bootstrap credential.
 *
 * It has no row and therefore no hash of its own — it is an environment variable compared in
 * constant time, never stored. But the list is the only place anyone can see what may reach this
 * server, and leaving out the credential most operators are actually holding made that list a lie by
 * omission: it showed every way in *except* the one you were using.
 *
 * A hash is 64 hex characters, so this cannot collide with a real one.
 */
const BOOTSTRAP_HASH = 'bootstrap'

/** Everything about a token except the secret, which is not stored and cannot be shown again. */
const publicView = (token: AccessToken) => ({
  tokenHash: token.tokenHash,
  label: token.label,
  scope: token.scope,
  createdWithToken: token.createdWithToken,
  createdAt: token.createdAt,
})

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
export const createTokenRoutes = (auth: AuthOptions) => {
  const routes = new Hono()

  routes.use('/*', requireScope(auth, 'admin'))

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid body' }, 400)

    const { label, scope } = body as { label?: unknown; scope?: unknown }
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return c.json({ error: 'label must be 1..128 characters' }, 400)
    }
    if (!isScope(scope)) return c.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, 400)

    const token = mintToken()
    const caller = c.get('caller')
    const record: AccessToken = {
      tokenHash: await hashToken(token),
      label,
      scope,
      // The bootstrap operator has no row of its own, so it is named rather than referenced.
      createdWithToken: caller.token?.tokenHash ?? 'bootstrap',
      createdAt: millis(Date.now()),
    }
    await auth.sql.insertAccessToken(record)

    // The only time the plaintext exists outside the caller's hands. Everything after this reads
    // the hash.
    return c.json({ token, ...publicView(record) }, 201)
  })

  routes.get('/', async (c) => {
    const stored = (await auth.sql.listAccessTokens()).map(publicView)
    const bootstrap = auth.bootstrapAdminToken
    if (bootstrap === undefined || bootstrap.length === 0) return c.json({ tokens: stored })
    return c.json({
      tokens: [
        {
          tokenHash: BOOTSTRAP_HASH,
          label: 'bootstrap',
          scope: 'admin' as const,
          createdBy: 'environment',
          // Unknown rather than invented. It was set whenever the server was deployed, which is not
          // something this process can find out.
          createdAt: 0,
          revokedAt: null,
          // Said on the wire rather than left for the client to infer from the label, which anyone
          // could give a real token.
          bootstrap: true,
        },
        ...stored,
      ],
    })
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
    await auth.sql.revokeAccessToken(tokenHash)
    return c.body(null, 204)
  })

  return routes
}
