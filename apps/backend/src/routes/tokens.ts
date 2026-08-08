import { millis } from '@wts/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScope } from '../auth/middleware.js'
import { hashToken, mintToken, SCOPES, type Scope } from '../auth/tokens.js'
import type { AccessToken } from '../ports/index.js'

const MAX_LABEL_LENGTH = 128

/** Everything about a token except the secret, which is not stored and cannot be shown again. */
const publicView = (token: AccessToken) => ({
  tokenHash: token.tokenHash,
  label: token.label,
  scope: token.scope,
  createdBy: token.createdBy,
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
      createdBy: caller.token?.tokenHash ?? 'bootstrap',
      createdAt: millis(Date.now()),
    }
    await auth.sql.insertAccessToken(record)

    // The only time the plaintext exists outside the caller's hands. Everything after this reads
    // the hash.
    return c.json({ token, ...publicView(record) }, 201)
  })

  routes.get('/', async (c) =>
    c.json({ tokens: (await auth.sql.listAccessTokens()).map(publicView) }),
  )

  routes.delete('/:tokenHash', async (c) => {
    const tokenHash = c.req.param('tokenHash')
    const existing = await auth.sql.readAccessToken(tokenHash)
    if (existing === null) return c.json({ error: 'not found' }, 404)

    // The response is the token as it last existed. Revoking deletes the row, so reading it back
    // afterwards would report "not found" for a call that just succeeded.
    await auth.sql.revokeAccessToken(tokenHash)
    return c.json(publicView(existing))
  })

  return routes
}
