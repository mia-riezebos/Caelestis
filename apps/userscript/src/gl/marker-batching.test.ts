import { beforeEach, describe, expect, it } from 'vitest'
import type { TileQuad } from '../tile-transform.js'
import {
  batchMarkerWork,
  beginMarkerBatchFrame,
  endMarkerBatchFrame,
  markerBatchMemoryBytes,
} from './marker-batching.js'

const tile = (x: number): TileQuad => ({
  tile: { x, y: 2 },
  x: x * 100,
  y: 200,
  width: 100,
  height: 100,
})

const style = {
  size: 7,
  thickness: 2,
  colour: [1, 0, 0] as const,
  otherColour: null,
  otherOpacity: 1,
  selected: -1,
}

const work = (at: TileQuad, marks: Uint32Array, overrides: Record<string, unknown> = {}) => ({
  tile: at,
  marks,
  style,
  fade: 1,
  padding: 4,
  ...overrides,
})

describe('marker draw batching', () => {
  beforeEach(() => {
    beginMarkerBatchFrame()
    endMarkerBatchFrame()
    beginMarkerBatchFrame()
  })

  it('combines identical template work into one stable point buffer per tile', () => {
    const at = tile(1)
    const first = new Uint32Array([1, 2])
    const second = new Uint32Array([3])
    const initial = batchMarkerWork([work(at, first), work(at, second)])
    const repeated = batchMarkerWork([work(at, first), work(at, second)])

    expect(initial).toHaveLength(1)
    expect(initial[0]?.marks).toEqual(new Uint32Array([1, 2, 3]))
    expect(repeated[0]?.marks).toBe(initial[0]?.marks)
    expect(markerBatchMemoryBytes()).toBe(12)
  })

  it('keeps separate tile transforms as separate draws', () => {
    const batches = batchMarkerWork([
      work(tile(1), new Uint32Array([1])),
      work(tile(2), new Uint32Array([2])),
    ])

    expect(batches).toHaveLength(2)
  })

  it('preserves exact order when appearances differ', () => {
    const at = tile(1)
    const first = work(at, new Uint32Array([1]))
    const second = work(at, new Uint32Array([2]), { style: { ...style, size: 9 } })

    expect(batchMarkerWork([first, second])).toEqual([first, second])
  })

  it('releases merged CPU buffers that are no longer drawn', () => {
    const at = tile(1)
    batchMarkerWork([work(at, new Uint32Array([1])), work(at, new Uint32Array([2]))])
    endMarkerBatchFrame()
    expect(markerBatchMemoryBytes()).toBe(8)

    beginMarkerBatchFrame()
    endMarkerBatchFrame()
    expect(markerBatchMemoryBytes()).toBe(0)
  })
})
