import { describe, expect, it, vi } from 'vitest'
import { DecodedPixelCache } from './decoded-pixel-cache.js'

describe('decoded pixel cache', () => {
  it('coalesces the same content key and expires it after the bounded TTL', async () => {
    let now = 1_000
    const cache = new DecodedPixelCache({ ttlMs: 120_000, now: () => now })
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]))

    await Promise.all([
      cache.get('canvas:hash-a', load, (value) => value.byteLength),
      cache.get('canvas:hash-a', load, (value) => value.byteLength),
    ])
    expect(load).toHaveBeenCalledTimes(1)

    now += 120_000
    await cache.get('canvas:hash-a', load, (value) => value.byteLength)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps content kinds and hashes separate while evicting the least recently used input', async () => {
    const cache = new DecodedPixelCache({ maxBytes: 4, maxEntries: 2 })
    const loads = new Map<string, number>()
    const read = (key: string, bytes: number) =>
      cache.get(
        key,
        async () => {
          loads.set(key, (loads.get(key) ?? 0) + 1)
          return new Uint8Array(bytes)
        },
        (value) => value.byteLength,
      )

    await read('chunk:same-hash', 2)
    await read('canvas:same-hash', 2)
    await read('chunk:same-hash', 2)
    await read('canvas:other-hash', 2)
    await read('canvas:same-hash', 2)

    expect(loads).toEqual(
      new Map([
        ['chunk:same-hash', 1],
        ['canvas:same-hash', 2],
        ['canvas:other-hash', 1],
      ]),
    )
  })

  it('does not retain failed decodes', async () => {
    const cache = new DecodedPixelCache()
    const load = vi
      .fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error('bad png'))
      .mockResolvedValueOnce(new Uint8Array([1]))

    await expect(cache.get('chunk:bad', load, (value) => value.byteLength)).rejects.toThrow(
      'bad png',
    )
    await expect(cache.get('chunk:bad', load, (value) => value.byteLength)).resolves.toEqual(
      new Uint8Array([1]),
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a missing decoded input', async () => {
    const cache = new DecodedPixelCache()
    const load = vi.fn(async () => null as Uint8Array | null)

    await cache.get('chunk:missing', load, (value) => value?.byteLength ?? 0)
    await cache.get('chunk:missing', load, (value) => value?.byteLength ?? 0)

    expect(load).toHaveBeenCalledTimes(2)
  })
})
