import { describe, expect, it } from 'vitest'
import { ByteCache } from './byte-cache.js'

describe('byte cache', () => {
  it('evicts oldest entries until both count and byte budgets fit', () => {
    const cache = new ByteCache<string>(3, 10)
    cache.set('first', new Uint8Array(4))
    cache.set('second', new Uint8Array(4))
    cache.set('third', new Uint8Array(4))

    expect(cache.get('first')).toBeUndefined()
    expect(cache.get('second')).toBeDefined()
    expect(cache.get('third')).toBeDefined()

    cache.set('fourth', new Uint8Array(7))
    expect(cache.get('second')).toBeUndefined()
    expect(cache.get('third')).toBeUndefined()
    expect(cache.get('fourth')).toBeDefined()
  })

  it('does not retain an entry larger than the whole byte budget', () => {
    const cache = new ByteCache<string>(3, 2)
    cache.set('large', new Uint8Array(3))
    expect(cache.get('large')).toBeUndefined()
  })
})
