import { Context, Effect, Layer } from 'effect'
import type { BlobStore, CounterStore, Ports, SqlStore } from '../ports/index.js'

export class BlobStoreService extends Context.Service<BlobStoreService, BlobStore>()(
  '@caelestis/backend/BlobStore',
) {}

export class SqlStoreService extends Context.Service<SqlStoreService, SqlStore>()(
  '@caelestis/backend/SqlStore',
) {}

export class CounterStoreService extends Context.Service<CounterStoreService, CounterStore>()(
  '@caelestis/backend/CounterStore',
) {}

export type BackendServices = BlobStoreService | SqlStoreService | CounterStoreService

export const contextFromPorts = (ports: Ports): Context.Context<BackendServices> =>
  Context.make(BlobStoreService, ports.blobs).pipe(
    Context.add(SqlStoreService, ports.sql),
    Context.add(CounterStoreService, ports.counters),
  )

export const layerFromPorts = (ports: Ports): Layer.Layer<BackendServices> =>
  Layer.succeedContext(contextFromPorts(ports))

export interface BackendRuntime {
  readonly context: Context.Context<BackendServices>
  readonly layer: Layer.Layer<BackendServices>
  readonly run: <A, E>(effect: Effect.Effect<A, E, BackendServices>) => Promise<A>
  readonly runHandled: <A, E, B>(
    effect: Effect.Effect<A, E, BackendServices>,
    onError: (error: E) => B,
  ) => Promise<A | B>
}

/**
 * The temporary bridge from the current dependency bag to Effect services.
 *
 * Routes migrate one at a time. The bridge disappears after the last caller stops accepting
 * `Ports`, while the Context service identities remain stable.
 */
export const createBackendRuntime = (ports: Ports): BackendRuntime => {
  const context = contextFromPorts(ports)
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
