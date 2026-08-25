import { describe, expect, it } from 'vitest'
import { gpuCacheEvictions } from './gpu-cache.js'

describe('overlay GPU cache policy', () => {
  it('drops deleted entries and then the oldest offscreen entries until under budget', () => {
    expect(
      gpuCacheEvictions(
        [
          { id: 'visible', bytes: 8, lastUsed: 4, visible: true, exists: true },
          { id: 'old', bytes: 6, lastUsed: 1, visible: false, exists: true },
          { id: 'recent', bytes: 6, lastUsed: 3, visible: false, exists: true },
          { id: 'deleted', bytes: 20, lastUsed: 5, visible: false, exists: false },
        ],
        14,
      ),
    ).toEqual(['deleted', 'old'])
  })

  it('never evicts a visible entry merely to satisfy the soft budget', () => {
    expect(
      gpuCacheEvictions([{ id: 'large', bytes: 20, lastUsed: 1, visible: true, exists: true }], 10),
    ).toEqual([])
  })
})
