import { describe, expect, it, vi } from 'vitest'
import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { DurableObjectStatusReadModel } from './do-status-read-model.js'

describe('DurableObjectStatusReadModel', () => {
  it('routes every behavior to the season-named Durable Object', async () => {
    const stub = {
      applyCommittedChange: vi.fn(async () => undefined),
      reconcileSnapshot: vi.fn(async ({ season }: { season: number }) => ({
        season,
        revision: 3,
        templates: [],
      })),
      attachSubscriber: vi.fn(async () => ({ revision: 3, snapshot: null })),
    }
    const getByName = vi.fn(() => stub)
    const model = new DurableObjectStatusReadModel({
      getByName,
    } as unknown as DurableObjectNamespace<StatusReadModelObject>)

    await model.applyCommittedChange({ season: 7, revision: 3 })
    await model.reconcileSnapshot({ season: 7, scope: 'read' })
    await model.attachSubscriber({ season: 7, scope: 'admin', afterRevision: 2 })

    expect(getByName).toHaveBeenCalledTimes(3)
    expect(getByName).toHaveBeenCalledWith('season:7')
    expect(stub.applyCommittedChange).toHaveBeenCalledWith({ season: 7, revision: 3 })
    expect(stub.reconcileSnapshot).toHaveBeenCalledWith({ season: 7, scope: 'read' })
    expect(stub.attachSubscriber).toHaveBeenCalledWith({
      season: 7,
      scope: 'admin',
      afterRevision: 2,
    })
  })
})
