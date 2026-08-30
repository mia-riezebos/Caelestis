import { describe, expect, it } from 'vitest'
import { TileOfferAcknowledgements } from './tile-offer-acknowledgements.js'

const book = (now: () => number = () => 1_000) =>
  new TileOfferAcknowledgements({
    ttlMs: 300,
    maxServers: 2,
    maxReceiptsPerServer: 2,
    now,
  })

describe('tile offer acknowledgements', () => {
  it('suppresses only a live acknowledgement for the same server, season, tile, and hash', () => {
    const receipts = book()
    const owner = {}
    receipts.acknowledged('https://one.example', owner, 1, '1/2\u0000hash-a')

    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000hash-a')).toBe('avoid')
    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000hash-b')).toBe('fresh')
    expect(receipts.decision('https://one.example', owner, 2, '1/2\u0000hash-a')).toBe('fresh')
  })

  it('retries attempted, expired, and reconnect-uncertain observations', () => {
    let now = 1_000
    const receipts = book(() => now)
    const owner = {}
    receipts.retryable('https://one.example', owner, 1, '1/2\u0000attempted')
    receipts.acknowledged('https://one.example', owner, 1, '1/2\u0000expired')
    now += 301

    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000attempted')).toBe('retry')
    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000expired')).toBe('retry')
    expect(receipts.decision('https://one.example', {}, 1, '1/2\u0000expired')).toBe('fresh')
  })

  it('holds an in-flight observation out of a second batch until its outcome is known', () => {
    let now = 1_000
    const receipts = book(() => now)
    const owner = {}
    receipts.started('https://one.example', owner, 1, '1/2\u0000hash')
    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000hash')).toBe('pending')

    receipts.retryable('https://one.example', owner, 1, '1/2\u0000hash')
    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000hash')).toBe('retry')

    receipts.started('https://one.example', owner, 1, '1/2\u0000hash')
    now += 301
    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000hash')).toBe('retry')
  })

  it('does not let a retired owner settle the replacement connection receipt', () => {
    const receipts = book()
    const retired = {}
    const replacement = {}
    receipts.started('https://one.example', retired, 1, '1/2\u0000hash')
    receipts.started('https://one.example', replacement, 1, '1/2\u0000hash')

    receipts.retryable('https://one.example', retired, 1, '1/2\u0000hash')
    receipts.acknowledged('https://one.example', retired, 1, '1/2\u0000hash')
    expect(receipts.decision('https://one.example', replacement, 1, '1/2\u0000hash')).toBe(
      'pending',
    )
  })

  it('starts uncertain after a client restart', () => {
    const owner = {}
    const beforeRestart = book()
    beforeRestart.acknowledged('https://one.example', owner, 1, '1/2\u0000hash')
    expect(beforeRestart.decision('https://one.example', owner, 1, '1/2\u0000hash')).toBe('avoid')

    const afterRestart = book()
    expect(afterRestart.decision('https://one.example', owner, 1, '1/2\u0000hash')).toBe('fresh')
  })

  it('invalidates only rejection receipts when manifest coverage changes', () => {
    const receipts = book()
    const owner = {}
    receipts.rejected('https://one.example', owner, 1, '1/2\u0000rejected')
    receipts.acknowledged('https://one.example', owner, 1, '1/3\u0000accepted')

    receipts.invalidateRejections('https://one.example', owner, 1)

    expect(receipts.decision('https://one.example', owner, 1, '1/2\u0000rejected')).toBe('fresh')
    expect(receipts.decision('https://one.example', owner, 1, '1/3\u0000accepted')).toBe('avoid')
  })

  it('bounds receipts and server scopes with oldest-first eviction', () => {
    const receipts = book()
    const one = {}
    receipts.acknowledged('https://one.example', one, 1, '1/1\u0000a')
    receipts.acknowledged('https://one.example', one, 1, '1/2\u0000b')
    receipts.acknowledged('https://one.example', one, 1, '1/3\u0000c')

    expect(receipts.decision('https://one.example', one, 1, '1/1\u0000a')).toBe('fresh')
    expect(receipts.decision('https://one.example', one, 1, '1/2\u0000b')).toBe('avoid')

    receipts.acknowledged('https://two.example', {}, 1, '1/1\u0000a')
    receipts.acknowledged('https://three.example', {}, 1, '1/1\u0000a')
    expect(receipts.decision('https://one.example', one, 1, '1/2\u0000b')).toBe('fresh')
  })
})
