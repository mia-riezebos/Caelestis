// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('marker device scale', () => {
  it('remeasures when browser zoom changes DPR without resizing the backing buffer', async () => {
    const canvas = document.createElement('canvas')
    let cssWidth = 1_200
    canvas.getBoundingClientRect = () => ({ width: cssWidth }) as DOMRect
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    const context = { canvas, drawingBufferWidth: 1_200 } as WebGL2RenderingContext
    const { deviceScale } = await import('./markers.js')

    expect(deviceScale(context)).toBe(1)

    cssWidth = 600
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    expect(deviceScale(context)).toBe(2)
  })
})
