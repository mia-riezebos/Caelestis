import { DurableObject } from 'cloudflare:workers'
import { millis } from '@caelestis/shared'
import { Effect } from 'effect'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { runAlarmWatcherCycle } from './alarm-watcher-cycle.js'
import {
  type BackendRuntime,
  createBackendRuntime,
  makeBackendContext,
  SqlStoreService,
} from './runtime/backend-runtime.js'

/** Owns the delayed ten-minute verification without competing with TelemetryShard's flush alarm. */
export class AlarmWatcher extends DurableObject<Env> {
  private readonly runtime: BackendRuntime

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runtime = createBackendRuntime(
      makeBackendContext(
        new R2BlobStore(env.BLOBS),
        new D1SqlStore(env.DB),
        new DurableObjectCounterStore(env.TELEMETRY),
      ),
    )
  }

  /** Reconcile the DO alarm with the earliest durable probe stored in D1. */
  async schedule(): Promise<void> {
    const dueAt = await this.runtime.run(
      Effect.gen(function* () {
        const sql = yield* SqlStoreService
        return yield* Effect.promise(() => sql.nextAlarmProbeAt())
      }),
    )
    if (dueAt === null) {
      // Do not delete here: a concurrent schedule may have installed a wakeup after the D1 read.
      // A stale alarm can safely wake once and reconcile an empty queue.
      return
    }
    await this.ctx.storage.setAlarm(dueAt)
  }

  override async alarm(): Promise<void> {
    const now = millis(Date.now())
    await runAlarmWatcherCycle(this.runtime, this.ctx.storage, now)
  }
}
