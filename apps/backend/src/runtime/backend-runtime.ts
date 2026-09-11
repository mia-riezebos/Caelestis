import { Context, Effect, Layer } from 'effect'
import type { BlobStore, CounterStore, SqlStore } from '../ports/index.js'
import type { PresencePort } from '../presence/port.js'
import { DirectStatusReadModel, type StatusReadModelPort } from '../status-read-model/port.js'

export class BlobStoreService extends Context.Service<BlobStoreService, BlobStore>()(
  '@caelestis/backend/BlobStore',
) {}

export class SqlStoreService extends Context.Service<SqlStoreService, SqlStore>()(
  '@caelestis/backend/SqlStore',
) {}

export class CounterStoreService extends Context.Service<CounterStoreService, CounterStore>()(
  '@caelestis/backend/CounterStore',
) {}

export class StatusReadModelService extends Context.Service<
  StatusReadModelService,
  StatusReadModelPort
>()('@caelestis/backend/StatusReadModel') {}

export type BackendServices =
  | PresenceService
  | BlobStoreService
  | SqlStoreService
  | CounterStoreService
  | StatusReadModelService
export type BackendContext = Context.Context<BackendServices>

export class PresenceService extends Context.Service<PresenceService, PresencePort>()(
  '@caelestis/backend/Presence',
) {}

const noPresence: PresencePort = { publishRegions: async () => {} }

export const makeBackendContext = (
  blobs: BlobStore,
  sql: SqlStore,
  counters: CounterStore,
  statusReadModel: StatusReadModelPort = new DirectStatusReadModel(sql),
  presence: PresencePort = noPresence,
): BackendContext =>
  Context.make(BlobStoreService, blobs).pipe(
    Context.add(SqlStoreService, sql),
    Context.add(CounterStoreService, counters),
    Context.add(StatusReadModelService, statusReadModel),
    Context.add(PresenceService, presence),
  )

export const makeBackendLayer = (
  blobs: BlobStore,
  sql: SqlStore,
  counters: CounterStore,
  statusReadModel: StatusReadModelPort = new DirectStatusReadModel(sql),
  presence: PresencePort = noPresence,
): Layer.Layer<BackendServices> =>
  Layer.succeedContext(makeBackendContext(blobs, sql, counters, statusReadModel, presence))

export interface BackendRuntime {
  readonly context: BackendContext
  readonly run: <A, E>(effect: Effect.Effect<A, E, BackendServices>) => Promise<A>
  readonly runHandled: <A, E, B>(
    effect: Effect.Effect<A, E, BackendServices>,
    onError: (error: E) => B,
  ) => Promise<A | B>
}

export const createBackendRuntime = (context: BackendContext): BackendRuntime => {
  return {
    context,
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
