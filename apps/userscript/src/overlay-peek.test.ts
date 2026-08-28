import { beforeEach, describe, expect, it } from 'vitest'
import { isOverlayPeekActive, setOverlayPeekActive } from './overlay-peek.js'

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
})
