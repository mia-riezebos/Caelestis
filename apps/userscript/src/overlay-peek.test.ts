import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isOverlayPeekActive, onOverlayPeekChange, setOverlayPeekActive } from './overlay-peek.js'

beforeEach(() => {
  setOverlayPeekActive(false)
})

describe('overlay peek', () => {
  it('is transient and reports only real render-state changes', () => {
    expect(isOverlayPeekActive()).toBe(false)
    expect(setOverlayPeekActive(true)).toBe(true)
    expect(setOverlayPeekActive(true)).toBe(false)
    expect(isOverlayPeekActive()).toBe(true)
    expect(setOverlayPeekActive(false)).toBe(true)
  })

  it('notifies independent render hosts only when peek changes', () => {
    const changed = vi.fn()
    const stop = onOverlayPeekChange(changed)

    setOverlayPeekActive(true)
    setOverlayPeekActive(true)
    setOverlayPeekActive(false)
    stop()
    setOverlayPeekActive(true)

    expect(changed).toHaveBeenCalledTimes(2)
  })
})
