import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash.js'

describe('sha256Hex', () => {
  it('returns lowercase SHA-256 hex', async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
