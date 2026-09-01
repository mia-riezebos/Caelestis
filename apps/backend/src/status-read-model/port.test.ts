import { millis } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import type { StatusReadModelPort } from './port.js'
import { repairCommittedTileGeneration } from './port.js'

describe('status read-model port helpers', () => {
  it('settles a prepared tile generation when cache repair rejects', async () => {
    const repairError = new Error('season object unavailable')
    const finishTileGenerationCommit = vi.fn(async () => undefined)
    const readModel = {
      applyCommittedChange: vi.fn(async () => null),
      reconcileSnapshot: vi.fn(),
      applyCommittedTileGeneration: vi.fn(async () => Promise.reject(repairError)),
      finishTileGenerationCommit,
    } as unknown as StatusReadModelPort
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generation = {
      tile: { x: 1, y: 2 },
      hash: 'a'.repeat(64),
      observedAt: millis(1_000),
      commitOrder: 1,
      coverageToken: 'coverage',
      commitToken: 'commit',
      commitExpiresAt: 2_000,
      visibleToPublic: true,
      visibleToAdmin: true,
    }

    await repairCommittedTileGeneration(readModel, 8, generation)

    expect(finishTileGenerationCommit).toHaveBeenCalledWith(8, generation.tile, {
      coverageToken: 'coverage',
      commitToken: 'commit',
      commitExpiresAt: 2_000,
    })
    expect(consoleError).toHaveBeenCalledWith(repairError)
  })
})
