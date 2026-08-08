import type { MiddlewareHandler } from 'hono'
import type { AccessToken, SqlStore } from '../ports/index.js'
import { hashToken, type Scope, satisfiesScope } from './tokens.js'

/** What a request proved about itself. */
export interface Caller {
  readonly scope: Scope
  /** The stored credential, or null for the bootstrap operator token, which has no row. */
  readonly token: AccessToken | null
  /**
   * The digest of whatever credential authenticated this request, bootstrap included.
   *
   * `token` is null for the operator secret because it has no `access_tokens` row, and callers that
   * record authorship still need something to record. Every author column is a 64-character hex
   * digest by CHECK, so a literal like `'bootstrap'` is not storable — this is.
   */
  readonly tokenHash: string
}

declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller
  }
}

/** Only the `Bearer <token>` form. `Basic` and bare tokens are not accepted. */
const bearerToken = (header: string | undefined): string | null => {
  if (header === undefined) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) return null
  const token = rest[0]
  return token === undefined || token.length === 0 ? null : token
}

/**
 * Constant-time string comparison, for the bootstrap token.
 *
 * The stored tokens are compared by SHA-256 hash, where a timing leak reveals nothing an attacker
 * can use — they would learn a prefix of a hash they cannot invert. The operator token is compared
 * raw, so it gets the real thing.
 */
const equalsConstantTime = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  // Length is not secret — it is visible in the request — so returning early on it is fine, and the
  // alternative would compare buffers of different sizes.
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is inside both arrays
    difference |= a[index]! ^ b[index]!
  }
  return difference === 0
}

export interface AuthOptions {
  readonly sql: SqlStore
  /**
   * The operator's bootstrap credential, from the environment.
   *
   * It mints the first real admin token and is not expected on ordinary requests. Absent or empty
   * means the server has no bootstrap path, which is the right default once real tokens exist.
   */
  readonly bootstrapAdminToken?: string | undefined
}

/**
 * Require at least `required` scope.
 *
 * Every rejection is a bare 401 or 403 with no detail. Distinguishing "no such token" from "revoked"
 * from "wrong scope" would let a holder of one credential probe for the existence of others.
 *
 * "Bare" is about detail, not about the body. Three reviewers have now read it as "send no body at
 * all" and filed the `{"error":"unauthorized"}` payload as a violation, so: the body is a constant
 * per status, identical for a missing header, a malformed scheme, an unknown token and a deleted
 * one. Nothing in it varies with the cause, which is the whole property. 401 versus 403 is the one
 * distinction that is deliberate — it tells a caller whether to authenticate or give up, and it
 * says nothing about any credential the caller does not already hold.
 */
export const requireScope =
  ({ sql, bootstrapAdminToken }: AuthOptions, required: Scope): MiddlewareHandler =>
  async (c, next) => {
    const presented = bearerToken(c.req.header('authorization'))
    if (presented === null) return c.json({ error: 'unauthorized' }, 401)

    // The `length > 0` arm is unreachable today and kept deliberately: `bearerToken` returns null
    // for an empty token, so `presented` is never '' and an empty configured secret can never match
    // on length. No test can pin it — said here rather than left looking load-bearing. It stays
    // because the day someone loosens `bearerToken`, an unset secret must not become a valid
    // credential.
    if (
      bootstrapAdminToken !== undefined &&
      bootstrapAdminToken.length > 0 &&
      equalsConstantTime(presented, bootstrapAdminToken)
    ) {
      c.set('caller', { scope: 'admin', token: null, tokenHash: await hashToken(presented) })
      return next()
    }

    // Absence is revocation. Revoking deletes the row, so there is no second "is it still live"
    // condition to forget — a reader that finds a token is holding a usable one.
    const token = await sql.readAccessToken(await hashToken(presented))
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    if (!satisfiesScope(token.scope, required)) return c.json({ error: 'forbidden' }, 403)

    c.set('caller', { scope: token.scope, token, tokenHash: token.tokenHash })
    return next()
  }
