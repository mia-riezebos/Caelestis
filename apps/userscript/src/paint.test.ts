import { describe, expect, it, vi } from 'vitest'
import { type FramePainter, paintFrame } from './paint.js'
import type { TileFrame } from './tile-transform.js'

const frame = { quads: [] } as unknown as TileFrame

describe('paintFrame', () => {
  it('clears default state and isolates every painter', () => {
    const calls: string[] = []
    const context = {
      canvas: { width: 320, height: 180 },
      reset: vi.fn(() => calls.push('reset')),
      clearRect: vi.fn(() => calls.push('clear')),
      save: vi.fn(() => calls.push('save')),
      restore: vi.fn(() => calls.push('restore')),
    } as unknown as CanvasRenderingContext2D
    const painters: FramePainter[] = [
      vi.fn(() => calls.push('first')),
      vi.fn(() => calls.push('second')),
    ]

    paintFrame(context, frame, painters, vi.fn())

    expect(calls).toEqual([
      'reset',
      'clear',
      'save',
      'first',
      'restore',
      'save',
      'second',
      'restore',
    ])
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 320, 180)
  })

  it('restores the context and continues when a painter throws', () => {
    const context = {
      canvas: { width: 1, height: 1 },
      reset: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    const failure = new Error('painter failed')
    const later = vi.fn()
    const onError = vi.fn()

    expect(() =>
      paintFrame(
        context,
        frame,
        [
          () => {
            throw failure
          },
          later,
        ],
        onError,
      ),
    ).not.toThrow()
    expect(context.restore).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(later).toHaveBeenCalledOnce()
  })
})
