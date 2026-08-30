import { DurableObject } from 'cloudflare:workers'
import { millis } from '@caelestis/shared'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { runAlarmWatcherCycle } from './alarm-watcher-cycle.js'
import type { Ports } from './ports/index.js'

/** Owns the delayed ten-minute verification without competing with TelemetryShard's flush alarm. */
export class AlarmWatcher extends DurableObject<Env> {
  private readonly ports: Ports

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ports = {
      blobs: new R2BlobStore(env.BLOBS),
      sql: new D1SqlStore(env.DB),
      counters: new DurableObjectCounterStore(env.TELEMETRY),
    }
  }

  /** Reconcile the DO alarm with the earliest durable probe stored in D1. */
  async schedule(): Promise<void> {
    const dueAt = await this.ports.sql.nextAlarmProbeAt()
    if (dueAt === null) {
      // Do not delete here: a concurrent schedule may have installed a wakeup after the D1 read.
      // A stale alarm can safely wake once and reconcile an empty queue.
      return
    }
    await this.ctx.storage.setAlarm(dueAt)
  }

  override async alarm(): Promise<void> {
    const now = millis(Date.now())
    await runAlarmWatcherCycle(this.ports, this.ctx.storage, now)
  }
}
