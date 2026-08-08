import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuidV7 } from './uuid.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidV7', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits canonical lowercase UUIDv7 values', () => {
    expect(uuidV7()).toMatch(UUID_V7)
  })

  it('is monotonic within one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const ids = Array.from({ length: 100 }, () => uuidV7())

    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
