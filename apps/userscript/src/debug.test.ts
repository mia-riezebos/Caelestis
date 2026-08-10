import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { count, counterKey, counters, installDebugApi, log, warn } from './debug.js'

/**
 * The counters are the only diagnostic for a feature whose failure looks like nothing happening at
 * all, and they run whether or not debugging is switched on. Both properties that keep them useful —
 * a key that does not carry coordinates, and a cap that does not silence what comes later — were
 * introduced as fixes and neither was pinned.
 */
beforeEach(() => {
  counters.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('installDebugApi', () => {
  it('defines the diagnostic surface and extensions on the page global', () => {
    const pageRealm = { Object }
    vi.stubGlobal('window', pageRealm)
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const mark = vi.fn()

    installDebugApi({ mark })

    const descriptor = Object.getOwnPropertyDescriptor(pageRealm, '__wts')
    if (descriptor === undefined) throw new Error('debug API must be defined on the page realm')
    expect(descriptor).toMatchObject({ writable: true, configurable: true, enumerable: false })
    expect((descriptor.value as Record<string, unknown>).mark).toBe(mark)
    expect((descriptor.value as Record<string, unknown>).counters).toBeTypeOf('function')
  })
})

describe('counterKey', () => {
  it.each([
    ['tile 12/34', 'fetch:tile'],
    ['matched 0/0 by identity', 'fetch:matched by identity'],
    [
      'DROPPED attribution 5/6 — re-uploaded unattributed',
      'fetch:DROPPED attribution — re-uploaded unattributed',
    ],
    ['wrapped the map WebGL context', 'fetch:wrapped the map WebGL context'],
  ])('strips the varying part of %j', (message, expected) => {
    expect(counterKey('fetch', message)).toBe(expected)
  })

  it('collapses a whole pan into one counter', () => {
    for (let x = 0; x < 500; x += 1) log('fetch', `tile ${x}/7`)

    expect(counters.get('fetch:tile')).toBe(500)
    expect(counters.size).toBe(1)
  })
})

describe('count', () => {
  it('caps how many distinct keys it will hold', () => {
    for (let index = 0; index < 500; index += 1) count(`key-${index}`)

    expect(counters.size).toBeLessThanOrEqual(201)
    expect(counters.get('debug:counter-keys-dropped')).toBeGreaterThan(0)
  })

  it('keeps counting keys it already knows once the table is full', () => {
    count('early')
    for (let index = 0; index < 500; index += 1) count(`key-${index}`)

    count('early')

    expect(counters.get('early')).toBe(2)
  })

  it('does not recurse when the drop counter is itself a new key', () => {
    // Counting the drop through `count` would, at capacity, count its own drop.
    for (let index = 0; index < 500; index += 1) count(`key-${index}`)

    expect(counters.get('debug:counter-keys-dropped')).toBeGreaterThan(0)
  })
})

describe('warn', () => {
  it('keys its counter the same way log does', () => {
    // The two hottest warnings carry tile coordinates. Keyed raw, they filled the table on their own
    // and every counter first seen afterwards was refused.
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (let x = 0; x < 300; x += 1) warn('texture', `DROPPED attribution ${x}/1 — re-uploaded`)

    expect(counters.size).toBeLessThan(10)
    expect(consoleWarn).toHaveBeenCalledTimes(300)
    count('bitmap:fell-back-to-byte-length')
    expect(counters.get('bitmap:fell-back-to-byte-length')).toBe(1)
  })

  it('never throws through page-controlled console sinks or serialization', () => {
    vi.stubGlobal('window', { Object })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '1'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('page console failed')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('page console failed')
    })
    installDebugApi()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => log('draw', 'circular payload', circular)).not.toThrow()
    expect(() => warn('install', 'warning sink failed')).not.toThrow()
  })

  it('does not retain attacker-sized messages or nested payloads in the event ring', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('window', { Object })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    installDebugApi()
    const huge = 'x'.repeat(1_000_000)

    warn('install', huge, { coords: huge })

    const api = (window as unknown as Record<string, unknown>).__wts as {
      events: () => Array<{ message: string; data: { coords: string } }>
    }
    const entry = api.events().at(-1)
    expect(entry?.message.length).toBeLessThanOrEqual(512)
    expect(entry?.data.coords.length).toBeLessThanOrEqual(512)
    expect(consoleWarn).toHaveBeenCalledOnce()
  })

  it('preserves bounded cross-realm Error diagnostics', () => {
    vi.stubGlobal('window', { Object })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    installDebugApi()
    const foreign = new (class ForeignError extends Error {})('decode failed')

    warn('install', 'tile failed', foreign)

    const api = (window as unknown as Record<string, unknown>).__wts as {
      events: () => Array<{ data?: unknown }>
    }
    expect(api.events().at(-1)?.data).toBe('Error: decode failed')
  })
})
