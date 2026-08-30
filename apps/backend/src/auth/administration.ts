import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import type { AccessToken } from '../ports/index.js'
import { AuthenticationConfigService, SqlStoreService } from '../runtime/backend-runtime.js'
import { BackendStorageError } from '../runtime/errors.js'
import { hashToken, mintToken, type Scope } from './tokens.js'

/** Even 128 control characters per label remain below the userscript's 64 KiB JSON cap. */
const TOKEN_PAGE_SIZE = 50

export interface TokenCursor {
  readonly createdAt: ReturnType<typeof millis>
  readonly tokenHash: string
}

/** Everything about a token except the secret, which is not stored and cannot be shown again. */
const publicView = (token: AccessToken) => ({
  tokenHash: token.tokenHash,
  label: token.label,
  scope: token.scope,
  createdWithToken: token.createdWithToken,
  createdAt: token.createdAt,
})

export const parseTokenCursor = (value: string | undefined): TokenCursor | null | undefined => {
  if (value === undefined) return undefined
  const match = /^(0|[1-9]\d*):([0-9a-f]{64})$/.exec(value)
  if (match === null) return null
  const createdAt = Number(match[1])
  return Number.isSafeInteger(createdAt)
    ? { createdAt: millis(createdAt), tokenHash: match[2] as string }
    : null
}

const tokenCursor = (token: AccessToken): string => `${token.createdAt}:${token.tokenHash}`

export const createAccessToken = (input: {
  readonly label: string
  readonly scope: Scope
  readonly createdWithToken: string
}): Effect.Effect<
  ReturnType<typeof publicView> & { readonly token: string },
  BackendStorageError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const token = yield* Effect.try({
      try: mintToken,
      catch: (cause) => new BackendStorageError({ operation: 'mintAccessToken', cause }),
    })
    const tokenHash = yield* Effect.tryPromise({
      try: () => hashToken(token),
      catch: (cause) => new BackendStorageError({ operation: 'hashAccessToken', cause }),
    })
    const record: AccessToken = {
      tokenHash,
      label: input.label,
      scope: input.scope,
      createdWithToken: input.createdWithToken,
      createdAt: millis(Date.now()),
    }
    yield* Effect.tryPromise({
      try: () => sql.insertAccessToken(record),
      catch: (cause) => new BackendStorageError({ operation: 'insertAccessToken', cause }),
    })
    return { token, ...publicView(record) }
  })

export const listAccessTokens = (
  cursor: TokenCursor | undefined,
): Effect.Effect<
  {
    readonly tokens: readonly (
      | ReturnType<typeof publicView>
      | {
          readonly label: 'bootstrap'
          readonly scope: 'admin'
          readonly createdAt: 0
          readonly bootstrap: true
        }
    )[]
    readonly nextCursor: string | null
  },
  BackendStorageError,
  AuthenticationConfigService | SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const { bootstrapAdminToken } = yield* AuthenticationConfigService
    const stored = yield* Effect.tryPromise({
      try: () =>
        sql.listAccessTokens({
          ...(cursor === undefined ? {} : { after: cursor }),
          limit: TOKEN_PAGE_SIZE + 1,
        }),
      catch: (cause) => new BackendStorageError({ operation: 'listAccessTokens', cause }),
    })
    const page = stored.slice(0, TOKEN_PAGE_SIZE).map(publicView)
    const nextCursor =
      stored.length > TOKEN_PAGE_SIZE && page.length > 0
        ? tokenCursor(page[page.length - 1] as AccessToken)
        : null
    if (
      bootstrapAdminToken === undefined ||
      bootstrapAdminToken.length === 0 ||
      cursor !== undefined
    ) {
      return { tokens: page, nextCursor }
    }
    return {
      tokens: [
        {
          label: 'bootstrap' as const,
          scope: 'admin' as const,
          createdAt: 0 as const,
          bootstrap: true as const,
        },
        ...page,
      ],
      nextCursor,
    }
  })

export const revokeAccessToken = (
  tokenHash: string,
): Effect.Effect<void, BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* Effect.tryPromise({
      try: () => sql.revokeAccessToken(tokenHash),
      catch: (cause) => new BackendStorageError({ operation: 'revokeAccessToken', cause }),
    })
  })
