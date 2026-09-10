import { DurableObject } from 'cloudflare:workers'
import { type Millis, millis } from '@caelestis/shared'
import { durableCoordinatorDatabase } from './adapters/cloudflare/coordinator-database.js'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { TelemetryCoordinator } from './coordination/telemetry.js'
import type { CounterDelta } from './ports/index.js'

/** Cloudflare lifecycle and storage binding for the shared telemetry coordinator. */
export class TelemetryShard extends DurableObject<Env> {
  private readonly coordinator: TelemetryCoordinator
  constructor(ctx: DurableObjectState, env: Env, clock: () => Millis = () => millis(Date.now())) {
    super(ctx, env)
    this.coordinator = new TelemetryCoordinator(
      durableCoordinatorDatabase(ctx.storage),
      ctx.storage,
      new D1SqlStore(env.DB),
      clock,
    )
    void ctx.blockConcurrencyWhile(() => this.coordinator.initialize())
  }
  record(deltas: readonly CounterDelta[], key?: string) {
    return this.coordinator.record(deltas, key)
  }
  readPending(ids: readonly string[]) {
    return this.coordinator.readPending(ids)
  }
  readDroppedLateCount() {
    return this.coordinator.readDroppedLateCount()
  }
  readFlushFailureCount() {
    return this.coordinator.readFlushFailureCount()
  }
  override alarm() {
    return this.coordinator.alarm()
  }
}
