import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMap, installMapCapture, releaseMapCapture } from './map-handle.js'

/**
 * The riskiest code in the userscript, and the only part that mutates something every object on the
 * page inherits from.
 *
 * It had no tests: the guard that stops it deleting somebody else's setter, the restore of a
 * descriptor it replaced and the check that decides what counts as a map could each be removed with
 * the whole workspace green. None of it needs a browser — the trap
 * is on `Object.prototype`, and a plain object assigned to is exactly the event it waits for.
 */
const WITNESS = '_canvasContainer'

const mapLike = () => ({
  flyTo: () => undefined,
  getZoom: () => 1,
  getCenter: () => ({ lng: 0, lat: 0 }),
  getCanvas: () => ({}) as HTMLCanvasElement,
  jumpTo: () => undefined,
})

const witnessDescriptor = () => Object.getOwnPropertyDescriptor(Object.prototype, WITNESS)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  releaseMapCapture()
  vi.useRealTimers()
  expect(witnessDescriptor()).toBeUndefined()
})

describe('installMapCapture', () => {
  it('installs the witness on an explicitly supplied page realm', () => {
    const pagePrototype = Object.create(null) as Record<string, unknown>
    const realm = { Object: { prototype: pagePrototype } } as unknown as Window & typeof globalThis
    const map = Object.assign(Object.create(pagePrototype), mapLike()) as Record<string, unknown>

    installMapCapture(realm)
    map[WITNESS] = { nodeName: 'DIV' }

    expect(getMap()).toBe(map)
    expect(Object.getOwnPropertyDescriptor(pagePrototype, WITNESS)).toBeDefined()
  })

  it('captures the object the assignment was made on', () => {
    installMapCapture()
    const map = mapLike()

    ;(map as Record<string, unknown>)[WITNESS] = { nodeName: 'DIV' }

    expect(getMap()).toBe(map)
  })

  it('leaves the assignment looking exactly like an ordinary one', () => {
    installMapCapture()
    const map = mapLike() as Record<string, unknown>
    const container = { nodeName: 'DIV' }

    map[WITNESS] = container

    expect(map[WITNESS]).toBe(container)
    expect(Object.getOwnPropertyDescriptor(map, WITNESS)).toEqual({
      value: container,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  })

  it('keeps the trap armed after capture so a replacement map can become current', () => {
    installMapCapture()
    expect(witnessDescriptor()).toBeDefined()

    const first = mapLike() as Record<string, unknown>
    const second = mapLike() as Record<string, unknown>
    first[WITNESS] = {}
    second[WITNESS] = {}

    expect(witnessDescriptor()).toBeDefined()
    expect(getMap()).toBe(second)
  })

  it.each([
    ['nothing map-like at all', { nothing: true }],
    // Each half of the check on its own: a lone `getZoom` or a lone `flyTo` is not a map, and
    // plenty of ordinary objects have one of them.
    ['only getZoom', { getZoom: () => 1 }],
    ['only flyTo', { flyTo: () => undefined }],
  ])('ignores an object with %s, and keeps waiting', (_label, candidate) => {
    installMapCapture()

    ;(candidate as Record<string, unknown>)[WITNESS] = {}

    expect(getMap()).toBeNull()
    expect(witnessDescriptor()).toBeDefined()
  })

  it('keeps waiting past a slow initial map load', () => {
    installMapCapture()

    vi.advanceTimersByTime(30_000)

    expect(witnessDescriptor()).toBeDefined()
    expect(getMap()).toBeNull()
  })

  it('does not remove a setter that replaces ours after capture', () => {
    installMapCapture()
    ;(mapLike() as Record<string, unknown>)[WITNESS] = {}
    const theirs = () => undefined
    Object.defineProperty(Object.prototype, WITNESS, { configurable: true, set: theirs })

    vi.advanceTimersByTime(60_000)

    expect(witnessDescriptor()?.set).toBe(theirs)
    delete (Object.prototype as Record<string, unknown>)[WITNESS]
  })

  it('leaves a pre-existing witness descriptor and its assignment semantics alone', () => {
    const assigned: unknown[] = []
    const theirs = (value: unknown) => assigned.push(value)
    Object.defineProperty(Object.prototype, WITNESS, { configurable: true, set: theirs })
    const candidate = mapLike() as Record<string, unknown>
    const container = { nodeName: 'DIV' }

    installMapCapture()
    candidate[WITNESS] = container

    expect(assigned).toEqual([container])
    expect(Object.hasOwn(candidate, WITNESS)).toBe(false)
    expect(witnessDescriptor()?.set).toBe(theirs)
    expect(getMap()).toBeNull()
    delete (Object.prototype as Record<string, unknown>)[WITNESS]
  })

  it('does not remove a setter that is not its own', () => {
    installMapCapture()
    const theirs = () => undefined
    Object.defineProperty(Object.prototype, WITNESS, { configurable: true, set: theirs })

    releaseMapCapture()

    expect(witnessDescriptor()?.set).toBe(theirs)
    delete (Object.prototype as Record<string, unknown>)[WITNESS]
  })

  it('preserves a failed assignment to a non-extensible receiver', () => {
    installMapCapture()
    const hostile = Object.preventExtensions({
      get flyTo(): never {
        throw new Error('nope')
      },
    })

    expect(() => {
      ;(hostile as Record<string, unknown>)[WITNESS] = {}
    }).toThrow(TypeError)
  })
})
