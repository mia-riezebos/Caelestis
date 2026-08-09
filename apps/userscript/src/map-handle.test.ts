import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMap, installMapCapture, releaseMapCapture } from './map-handle.js'

/**
 * The riskiest code in the userscript, and the only part that mutates something every object on the
 * page inherits from.
 *
 * It had no tests: the guard that stops it deleting somebody else's setter, the restore of a
 * descriptor it replaced, the timer it cancels on capture and the check that decides what counts as
 * a map could each be removed with the whole workspace green. None of it needs a browser — the trap
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

  it('removes the trap as soon as it has what it came for', () => {
    installMapCapture()
    expect(witnessDescriptor()).toBeDefined()

    ;(mapLike() as Record<string, unknown>)[WITNESS] = {}

    expect(witnessDescriptor()).toBeUndefined()
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

  it('gives up after the release window even if no map ever appears', () => {
    installMapCapture()

    vi.advanceTimersByTime(30_000)

    expect(witnessDescriptor()).toBeUndefined()
    expect(getMap()).toBeNull()
  })

  it('cancels the release timer once it has captured', () => {
    // Otherwise the timer fires later and deletes whatever now sits under that name — which, after
    // capture, is nothing of ours.
    installMapCapture()
    ;(mapLike() as Record<string, unknown>)[WITNESS] = {}
    const theirs = () => undefined
    Object.defineProperty(Object.prototype, WITNESS, { configurable: true, set: theirs })

    vi.advanceTimersByTime(60_000)

    expect(witnessDescriptor()?.set).toBe(theirs)
    delete (Object.prototype as Record<string, unknown>)[WITNESS]
  })

  it('restores a descriptor it replaced rather than deleting it', () => {
    const theirs = { configurable: true, writable: true, enumerable: false, value: 'theirs' }
    Object.defineProperty(Object.prototype, WITNESS, theirs)

    installMapCapture()
    ;(mapLike() as Record<string, unknown>)[WITNESS] = {}

    expect(witnessDescriptor()).toMatchObject({ value: 'theirs' })
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

  it('does not let a hostile receiver throw out of the page assignment', () => {
    // The setter runs inside somebody else's `obj.x = y`. A detection failure there aborts whatever
    // was initialising, which on this path is the map itself.
    installMapCapture()
    const hostile = Object.preventExtensions({
      get flyTo(): never {
        throw new Error('nope')
      },
    })

    expect(() => {
      ;(hostile as Record<string, unknown>)[WITNESS] = {}
    }).not.toThrow()
  })
})
