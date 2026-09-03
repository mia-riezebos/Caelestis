import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isOverlayPeekActive,
  onOverlayPeekChange,
  overlayPeekFade,
  setOverlayPeekActive,
} from './overlay-peek.js'

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

  it('fades both ways and reverses from the opacity already on screen', () => {
    let now = performance.now() + 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    expect(overlayPeekFade(now)).toEqual({ opacity: 1, done: true })

    setOverlayPeekActive(true)
    expect(overlayPeekFade(now)).toEqual({ opacity: 1, done: false })
    now += 150
    expect(overlayPeekFade(now).opacity).toBeCloseTo(0.5, 2)

    setOverlayPeekActive(false)
    now += 150
    expect(overlayPeekFade(now).opacity).toBeCloseTo(0.75, 2)
    now += 150
    expect(overlayPeekFade(now)).toEqual({ opacity: 1, done: true })
  })
})
