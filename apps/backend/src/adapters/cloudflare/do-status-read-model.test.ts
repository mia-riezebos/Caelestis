import { describe, expect, it, vi } from 'vitest'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { DurableObjectStatusReadModel } from './do-status-read-model.js'

describe('Durable Object status read-model adapter', () => {
  it('routes every operation to the season-scoped object', async () => {
    const stub = {
      applyCommittedChange: vi.fn(async () => undefined),
      reconcileSnapshot: vi.fn(async () => ({
        cacheOutcome: 'hit' as const,
        snapshot: { revision: 4, templates: [] },
      })),
    }
    const namespace = {
      getByName: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<StatusReadModelObject>
    const model = new DurableObjectStatusReadModel(namespace)

    await model.applyCommittedChange(8)
    await expect(model.reconcileSnapshot(8, 'admin')).resolves.toEqual({
      cacheOutcome: 'hit',
      snapshot: { revision: 4, templates: [] },
    })

    expect(namespace.getByName).toHaveBeenCalledWith('season:8')
    expect(stub.applyCommittedChange).toHaveBeenCalledWith(8)
    expect(stub.reconcileSnapshot).toHaveBeenCalledWith(8, 'admin')
  })
})
