// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createRangeGestures } from './range-gestures.js'

const range = (): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = 'range'
  document.body.appendChild(input)
  return input
}

describe('range gestures', () => {
  it('settles a pointer gesture when its pointer ends', () => {
    const gestures = createRangeGestures()
    const input = range()
    const settle = vi.fn()
    gestures.bind(input, settle)

    input.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7 }))
    expect(gestures.isHeldWithin(document.body)).toBe(true)
    input.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))

    expect(settle).toHaveBeenCalledTimes(1)
    expect(gestures.isHeldWithin(document.body)).toBe(false)
  })

  it('waits for a movement key to be released before settling', () => {
    const gestures = createRangeGestures()
    const input = range()
    const settle = vi.fn()
    gestures.bind(input, settle)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    input.dispatchEvent(new Event('change'))
    expect(settle).not.toHaveBeenCalled()

    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('retires only disconnected pointers', () => {
    const gestures = createRangeGestures()
    const root = document.createElement('div')
    const first = range()
    const second = range()
    root.append(first, second)
    document.body.appendChild(root)
    gestures.bind(first, vi.fn())
    gestures.bind(second, vi.fn())

    first.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    second.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }))
    first.remove()
    gestures.releaseDisconnected((input) => input.isConnected)

    expect(gestures.isHeldWithin(root)).toBe(true)
    second.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    expect(gestures.isHeldWithin(root)).toBe(false)
  })

  it('releases every hold during teardown', () => {
    const gestures = createRangeGestures()
    const input = range()
    gestures.bind(input, vi.fn())
    input.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3 }))

    gestures.releaseAll()

    expect(gestures.isHeldWithin(document.body)).toBe(false)
  })
})
