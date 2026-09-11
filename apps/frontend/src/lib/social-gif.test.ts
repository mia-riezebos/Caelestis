import { beforeEach, expect, it, vi } from 'vitest'

const { writes, bytes } = vi.hoisted(() => ({
  writes: vi.fn(),
  bytes: vi.fn(),
}))
vi.mock('gifenc/dist/gifenc.js', () => ({
  default: {
    quantize: () => [[0, 0, 0]],
    applyPalette: (frame: Uint8Array) => frame.slice(0, 1),
    GIFEncoder: () => ({ writeFrame: writes, finish: () => {}, bytes }),
  },
}))

import { encodeTimelapseGif } from './social-gif.js'

beforeEach(() => {
  writes.mockClear()
  bytes.mockReset()
})

it('retries oversized GIFs with both history endpoints and redistributes their original duration', () => {
  bytes
    .mockReturnValueOnce(new Uint8Array(4_500_001))
    .mockReturnValueOnce(new Uint8Array(4_500_001))
    .mockReturnValue(new Uint8Array(10))
  const frames = Array.from({ length: 9 }, (_, i) => Uint8Array.of(i, 0, 0, 255))
  expect(encodeTimelapseGif(frames, 1, 1)).toHaveLength(10)
  const final = writes.mock.calls.slice(-4)
  expect(final.map(([indices]) => indices[0])).toEqual([0, 4, 7, 8])
  expect(final.map(([, , , options]) => options.delay)).toEqual([3340, 3330, 3330, 5000])
})

it('fails visibly when even the history endpoints and final state exceed the size limit', () => {
  bytes.mockReturnValue(new Uint8Array(4_500_001))
  const frames = [0, 1, 2].map((i) => Uint8Array.of(i, 0, 0, 255))
  expect(() => encodeTimelapseGif(frames, 1, 1)).toThrow('share image size limit')
  expect(bytes).toHaveBeenCalledOnce()
})
