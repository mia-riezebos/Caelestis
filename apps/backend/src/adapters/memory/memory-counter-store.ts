import type { CounterDelta, CounterStore, PendingCounters } from '../../ports/index.js'

export class MemoryCounterStore implements CounterStore {
  private readonly counters = new Map<string, PendingCounters>()

  async record(deltas: readonly CounterDelta[]): Promise<void> {
    for (const delta of deltas) {
      const current = this.counters.get(delta.templateId)
      this.counters.set(delta.templateId, {
        templateId: delta.templateId,
        placed: (current?.placed ?? 0) + delta.placed,
        correct: (current?.correct ?? 0) + delta.correct,
        repairs: (current?.repairs ?? 0) + delta.repairs,
        flushedAt: current?.flushedAt ?? null,
      })
    }
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    return templateIds.map((templateId) => {
      const counters = this.counters.get(templateId)
      return counters === undefined
        ? { templateId, placed: 0, correct: 0, repairs: 0, flushedAt: null }
        : { ...counters }
    })
  }
}
