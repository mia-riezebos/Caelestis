import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import type { AccessToken, AccessTokenQuery } from '../ports/index.js'
import { SqlStoreService, StatusReadModelService } from '../runtime/backend-runtime.js'
import { BackendStorageError } from '../runtime/errors.js'
import { closeLiveCredential } from '../status-read-model/port.js'
import { hashToken, mintToken, type Scope } from './tokens.js'

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackendStorageError({ operation, cause }),
  })

export const mintAccessToken = (input: {
  readonly label: string
  readonly scope: Scope
  readonly createdWithToken: string
}): Effect.Effect<
  { readonly token: string; readonly record: AccessToken },
  BackendStorageError,
  SqlStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const token = mintToken()
    const tokenHash = yield* storage('hashToken', () => hashToken(token))
    const record: AccessToken = {
      tokenHash,
      label: input.label,
      scope: input.scope,
      createdWithToken: input.createdWithToken,
      createdAt: millis(Date.now()),
    }
    yield* storage('insertAccessToken', () => sql.insertAccessToken(record))
    return { token, record }
  })

export const listAccessTokens = (
  query: AccessTokenQuery,
): Effect.Effect<readonly AccessToken[], BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* storage('listAccessTokens', () => sql.listAccessTokens(query))
  })

export const revokeAccessToken = (
  tokenHash: string,
): Effect.Effect<void, BackendStorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    yield* storage('revokeAccessToken', () => sql.revokeAccessToken(tokenHash))
  })

export const revokeAccessTokenAndLiveSessions = (
  tokenHash: string,
  season: number,
): Effect.Effect<void, BackendStorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    yield* revokeAccessToken(tokenHash)
    const statusReadModel = yield* StatusReadModelService
    yield* Effect.promise(() => closeLiveCredential(statusReadModel, season, tokenHash))
  })
