import { millis } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import { SCOPES, type Scope } from '../auth/tokens.js'
import {
  listAccessTokens,
  mintAccessToken,
  revokeAccessTokenAndLiveSessions,
} from '../auth/use-cases.js'
import type { AccessToken } from '../ports/index.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'

const MAX_LABEL_LENGTH = 128
/** Even 128 control characters per label remain below the userscript's 64 KiB JSON cap. */
const TOKEN_PAGE_SIZE = 50

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

interface TokenCursor {
  readonly createdAt: ReturnType<typeof millis>
  readonly tokenHash: string
}

const parseCursor = (value: string | undefined): TokenCursor | null | undefined => {
  if (value === undefined) return undefined
  const match = /^(0|[1-9]\d*):([0-9a-f]{64})$/.exec(value)
  if (match === null) return null
  const createdAt = Number(match[1])
  return Number.isSafeInteger(createdAt)
    ? { createdAt: millis(createdAt), tokenHash: match[2] as string }
    : null
}

const tokenCursor = (token: AccessToken): string => `${token.createdAt}:${token.tokenHash}`

/**
 * Token administration.
 *
 * Admin-only throughout: a `report` holder that could mint itself `admin` would make the scope
 * ladder decorative.
 *
 * @see .scratch/v1/issues/03-auth-model.md
 */
export const createTokenRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  currentSeason: number,
) => {
  const routes = new Hono()

  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))

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
      mintAccessToken({
        label,
        scope,
        // The bootstrap operator has no row of its own, so it is named rather than referenced.
        createdWithToken: caller.token?.tokenHash ?? 'bootstrap',
      }),
      ({ token, record }) =>
        // The only time the plaintext exists outside the caller's hands. Everything after this reads
        // the hash.
        c.json({ token, ...publicView(record) }, 201),
    )
  })

  routes.get('/', async (c) => {
    const cursor = parseCursor(c.req.query('cursor'))
    if (cursor === null) return c.json({ error: 'cursor is invalid' }, 400)
    return runBackendHttp(
      c,
      runtime,
      listAccessTokens({
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: TOKEN_PAGE_SIZE + 1,
      }),
      (stored) => {
        const page = stored.slice(0, TOKEN_PAGE_SIZE).map(publicView)
        const nextCursor =
          stored.length > TOKEN_PAGE_SIZE && page.length > 0
            ? tokenCursor(page[page.length - 1] as AccessToken)
            : null
        const bootstrap = auth.bootstrapAdminToken
        if (bootstrap === undefined || bootstrap.length === 0 || cursor !== undefined) {
          return c.json({ tokens: page, nextCursor })
        }
        return c.json({
          tokens: [
            {
              label: 'bootstrap',
              scope: 'admin' as const,
              // Unknown rather than invented. It was set whenever the server was deployed, which is not
              // something this process can find out.
              createdAt: 0,
              // Said on the wire rather than left for the client to infer from the label, which anyone
              // could give a real token.
              bootstrap: true,
            },
            ...page,
          ],
          nextCursor,
        })
      },
    )
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
    return runBackendHttp(
      c,
      runtime,
      revokeAccessTokenAndLiveSessions(tokenHash, currentSeason),
      () => c.body(null, 204),
    )
  })

  return routes
}
