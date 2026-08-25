import { describe, expect, it, vi } from 'vitest'
import { frameQueue } from './frame-queue.js'

describe('frame queue', () => {
  it('coalesces a burst and permits a later frame', () => {
    const frames: FrameRequestCallback[] = []
    const run = vi.fn()
    const queue = frameQueue(run, (callback) => {
      frames.push(callback)
      return frames.length
    })

    queue()
    queue()
    queue()
    expect(frames).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()

    frames.shift()?.(0)
    expect(run).toHaveBeenCalledOnce()
    queue()
    expect(frames).toHaveLength(1)
  })
})
