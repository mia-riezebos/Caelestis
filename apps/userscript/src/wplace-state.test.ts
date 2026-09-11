// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))

/** A class built the way the bundle builds Wplace's state: private fields kept in WeakMaps. */
const buildState = (realm: { WeakMap: WeakMapConstructor }) => {
  const themes = new realm.WeakMap<object, string>()
  const opens = new realm.WeakMap<object, boolean>()
  class State {
    constructor() {
      opens.set(this, false)
      themes.set(this, 'custom-winter')
    }
    get theme(): string {
      return themes.get(this) ?? ''
    }
    set theme(value: string) {
      themes.set(this, value)
      document.documentElement.setAttribute('data-theme', value)
    }
  }
  return new State()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  const { releaseWplaceStateCapture } = await import('./wplace-state.js')
  releaseWplaceStateCapture()
  vi.useRealTimers()
  vi.resetModules()
})

describe('wplace state capture', () => {
  it('catches the state instance while it is being built and disarms', async () => {
    const realm = { WeakMap } as unknown as Window & typeof globalThis
    const native = WeakMap.prototype.set
    const { installWplaceStateCapture, getWplaceState } = await import('./wplace-state.js')
    installWplaceStateCapture(realm)
    expect(WeakMap.prototype.set).not.toBe(native)

    const state = buildState(realm)
    expect(getWplaceState()).toBe(state)
    expect(WeakMap.prototype.set).toBe(native)

    state.theme = 'dark'
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(state.theme).toBe('dark')
  })

  it('ignores objects without a theme setter and gives up after the startup window', async () => {
    const realm = { WeakMap } as unknown as Window & typeof globalThis
    const native = WeakMap.prototype.set
    const { installWplaceStateCapture, getWplaceState } = await import('./wplace-state.js')
    installWplaceStateCapture(realm)
    new WeakMap().set({ theme: 'not an accessor' }, 1)
    class Other {
      get theme(): string {
        return 'read only'
      }
    }
    new WeakMap().set(new Other(), 1)
    expect(getWplaceState()).toBeNull()

    vi.advanceTimersByTime(20_000)
    expect(WeakMap.prototype.set).toBe(native)
    buildState(realm)
    expect(getWplaceState()).toBeNull()
  })

  it('completes the original call even when detection throws', async () => {
    const realm = { WeakMap } as unknown as Window & typeof globalThis
    const { installWplaceStateCapture } = await import('./wplace-state.js')
    installWplaceStateCapture(realm)
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('no')
        },
      },
    )
    const map = new WeakMap<object, number>()
    expect(() => map.set(hostile, 1)).not.toThrow()
    expect(map.get(hostile)).toBe(1)
  })
})
