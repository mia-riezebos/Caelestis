import type { CounterDelta, CounterStore, PendingCounters } from '../../ports/index.js'
import type { TelemetryShard } from '../../telemetry-shard.js'

const SINGLE_SHARD_NAME = 'telemetry'

export class DurableObjectCounterStore implements CounterStore {
  private readonly shard: DurableObjectStub<TelemetryShard>

  constructor(namespace: DurableObjectNamespace<TelemetryShard>) {
    this.shard = namespace.getByName(SINGLE_SHARD_NAME)
  }

  async record(deltas: readonly CounterDelta[], idempotencyKey?: string): Promise<void> {
    await this.shard.record(deltas, idempotencyKey)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    return this.shard.readPending(templateIds)
  }

  async readDroppedLateCount(): Promise<number> {
    return this.shard.readDroppedLateCount()
  }

  async readFlushFailureCount(): Promise<number> {
    return this.shard.readFlushFailureCount()
  }
}
