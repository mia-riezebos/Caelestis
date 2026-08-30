import { Context, Effect, Layer } from 'effect'
import type { BlobStore, CounterStore, SqlStore } from '../ports/index.js'

export interface AuthenticationConfig {
  readonly bootstrapAdminToken?: string | undefined
  readonly openAccess?: boolean | undefined
}

export class BlobStoreService extends Context.Service<BlobStoreService, BlobStore>()(
  '@caelestis/backend/BlobStore',
) {}

export class SqlStoreService extends Context.Service<SqlStoreService, SqlStore>()(
  '@caelestis/backend/SqlStore',
) {}

export class CounterStoreService extends Context.Service<CounterStoreService, CounterStore>()(
  '@caelestis/backend/CounterStore',
) {}

export class AuthenticationConfigService extends Context.Service<
  AuthenticationConfigService,
  AuthenticationConfig
>()('@caelestis/backend/AuthenticationConfig') {}

export type BackendServices =
  | BlobStoreService
  | SqlStoreService
  | CounterStoreService
  | AuthenticationConfigService

export const makeBackendContext = (
  blobs: BlobStore,
  sql: SqlStore,
  counters: CounterStore,
  authentication: AuthenticationConfig = {},
): Context.Context<BackendServices> =>
  Context.make(BlobStoreService, blobs).pipe(
    Context.add(SqlStoreService, sql),
    Context.add(CounterStoreService, counters),
    Context.add(AuthenticationConfigService, authentication),
  )

export interface BackendRuntime {
  readonly context: Context.Context<BackendServices>
  readonly layer: Layer.Layer<BackendServices>
  readonly run: <A, E>(effect: Effect.Effect<A, E, BackendServices>) => Promise<A>
  readonly runHandled: <A, E, B>(
    effect: Effect.Effect<A, E, BackendServices>,
    onError: (error: E) => B,
  ) => Promise<A | B>
}

export const createBackendRuntime = (context: Context.Context<BackendServices>): BackendRuntime => {
  const layer = Layer.succeedContext(context)

  return {
    context,
    layer,
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, context)),
    runHandled: (effect, onError) =>
      Effect.runPromise(
        Effect.provideContext(
          Effect.catch(effect, (error) => Effect.succeed(onError(error))),
          context,
        ),
      ),
  }
}
