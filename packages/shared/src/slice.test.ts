import { describe, expect, it } from 'vitest'
import { TRANSPARENT_INDEX } from './palette.js'
import { boundsOverlap, SliceError, sliceTemplate } from './slice.js'
import { TILE_SIZE, WORLD_PIXELS } from './tiles.js'

const T = TRANSPARENT_INDEX

/** An image of palette indices from a row-major grid, so fixtures read as pictures. */
const image = (rows: number[][]): { indices: Uint8Array; width: number; height: number } => ({
  indices: new Uint8Array(rows.flat()),
  width: rows[0]?.length ?? 0,
  height: rows.length,
})

describe('the bounding box', () => {
  it('is the painted extent, not the image rect', () => {
    // A transparent margin must not enlarge the box: culling, overlap detection and the progress
    // ceiling all read it, and every one of them would be working from padding.
    const { indices, width, height } = image([
      [T, T, T, T],
      [T, 5, 6, T],
      [T, T, T, T],
    ])

    const { bbox, totalPixels } = sliceTemplate(indices, width, height, 100, 200)

    expect(bbox).toEqual({ minX: 101, minY: 201, maxX: 103, maxY: 202 })
    expect(totalPixels).toBe(2)
  })

  it('treats max as exclusive, so a single pixel spans one', () => {
    const { indices, width, height } = image([[7]])
    expect(sliceTemplate(indices, width, height, 10, 20).bbox).toEqual({
      minX: 10,
      minY: 20,
      maxX: 11,
      maxY: 21,
    })
  })

  it('counts only painted pixels towards the total', () => {
    const { indices, width, height } = image([
      [1, T],
      [T, 2],
    ])
    expect(sliceTemplate(indices, width, height, 0, 0).totalPixels).toBe(2)
  })
})

describe('slicing', () => {
  it('produces one chunk when the template sits inside a tile', () => {
    const { indices, width, height } = image([
      [1, 2],
      [3, 4],
    ])

    const { chunks } = sliceTemplate(indices, width, height, 10, 20)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ tileX: 0, tileY: 0, width: 2, height: 2 })
    expect([...(chunks[0]?.indices ?? [])]).toEqual([1, 2, 3, 4])
  })

  it('splits on the tile boundary and keeps each side whole', () => {
    // Straddling x = TILE_SIZE by one pixel each way is the case that catches an off-by-one in the
    // intersection: a wrong edge either drops a column or duplicates one.
    const { indices, width, height } = image([[1, 2]])

    const { chunks } = sliceTemplate(indices, width, height, TILE_SIZE - 1, 0)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ tileX: 0, tileY: 0, width: 1, height: 1 })
    expect([...(chunks[0]?.indices ?? [])]).toEqual([1])
    expect(chunks[1]).toMatchObject({ tileX: 1, tileY: 0, width: 1, height: 1 })
    expect([...(chunks[1]?.indices ?? [])]).toEqual([2])
  })

  it('splits in both axes at once', () => {
    const { indices, width, height } = image([
      [1, 2],
      [3, 4],
    ])

    const { chunks } = sliceTemplate(indices, width, height, TILE_SIZE - 1, TILE_SIZE - 1)

    expect(chunks.map((chunk) => [chunk.tileX, chunk.tileY])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ])
    expect(chunks.map((chunk) => [...chunk.indices])).toEqual([[1], [2], [3], [4]])
  })

  it('emits no chunk for a tile it spans but paints nothing in', () => {
    // A diagonal across four tiles paints in two. Emitting the empty pair would store blank images
    // and advertise coverage the template does not have.
    const size = TILE_SIZE + 2
    const indices = new Uint8Array(size * size).fill(T)
    indices[0] = 1
    indices[size * size - 1] = 2

    const { chunks } = sliceTemplate(indices, size, size, TILE_SIZE - 1, TILE_SIZE - 1)

    // Origin (999, 999) with a 1002-square image spans tiles 0..2 on both axes — nine tiles, two
    // painted.
    expect(chunks.map((chunk) => [chunk.tileX, chunk.tileY])).toEqual([
      [0, 0],
      [2, 2],
    ])
  })

  it.each([
    ['ending exactly on the tile edge', TILE_SIZE - 2, 1],
    ['reaching one pixel past it', TILE_SIZE - 1, 2],
  ])('spans the right tiles when %s', (_label, originX, expectedTiles) => {
    // The exclusive bound decides this: a box ending exactly on an edge must not reach into the
    // next tile.
    const { indices, width, height } = image([[1, 2]])
    const { chunks } = sliceTemplate(indices, width, height, originX, 0)
    expect(chunks).toHaveLength(expectedTiles)
  })

  it('pads a chunk with transparent where the template does not cover it', () => {
    const { indices, width, height } = image([
      [1, T],
      [T, 2],
    ])

    const { chunks } = sliceTemplate(indices, width, height, 0, 0)

    expect([...(chunks[0]?.indices ?? [])]).toEqual([1, T, T, 2])
  })

  it('keeps every chunk exactly the bbox-tile intersection', () => {
    // This is what lets the wire carry only {tile, hash}: offset and size are recoverable from the
    // bounding box and the tile key, so they cannot drift out of agreement with it.
    const size = TILE_SIZE + 500
    const indices = new Uint8Array(size * size).fill(1)

    const { bbox, chunks } = sliceTemplate(indices, size, size, 700, 800)

    for (const chunk of chunks) {
      const startX = Math.max(bbox.minX, chunk.tileX * TILE_SIZE)
      const endX = Math.min(bbox.maxX, (chunk.tileX + 1) * TILE_SIZE)
      const startY = Math.max(bbox.minY, chunk.tileY * TILE_SIZE)
      const endY = Math.min(bbox.maxY, (chunk.tileY + 1) * TILE_SIZE)
      expect({ width: chunk.width, height: chunk.height }).toEqual({
        width: endX - startX,
        height: endY - startY,
      })
    }
  })

  it('reassembles to the original painted pixels', () => {
    // The property that matters: slicing loses nothing and moves nothing.
    const size = TILE_SIZE + 37
    const indices = new Uint8Array(size * size).fill(T)
    for (let index = 0; index < size * size; index += 7) indices[index] = index % 63
    const originX = TILE_SIZE - 11
    const originY = TILE_SIZE - 23

    const { bbox, chunks } = sliceTemplate(indices, size, size, originX, originY)

    // Reassemble the way a client has to: a chunk's top-left is not its tile's origin, it is
    // max(bbox.min, tile origin). That derivation is exactly why the wire can carry {tile, hash}
    // and nothing more, so reproducing it here is testing the contract rather than the code.
    const canvas = new Map<string, number>()
    for (const chunk of chunks) {
      const startX = Math.max(bbox.minX, chunk.tileX * TILE_SIZE)
      const startY = Math.max(bbox.minY, chunk.tileY * TILE_SIZE)
      for (let y = 0; y < chunk.height; y += 1) {
        for (let x = 0; x < chunk.width; x += 1) {
          const value = chunk.indices[y * chunk.width + x] ?? T
          if (value === T) continue
          canvas.set(`${startX + x}/${startY + y}`, value)
        }
      }
    }

    let expected = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const value = indices[y * size + x] ?? T
        if (value === T) continue
        expected += 1
        expect(canvas.get(`${originX + x}/${originY + y}`)).toBe(value)
      }
    }
    expect(canvas.size).toBe(expected)
  })
})

describe('rejections', () => {
  it('rejects an index buffer that does not match the dimensions', () => {
    expect(() => sliceTemplate(new Uint8Array(3), 2, 2, 0, 0)).toThrow(/expected 4 indices/)
  })

  it('rejects a template with nothing painted', () => {
    const { indices, width, height } = image([[T, T]])
    expect(() => sliceTemplate(indices, width, height, 0, 0)).toThrow(/no painted pixels/)
  })

  it.each([
    ['a negative origin', -1, 0],
    ['a fractional origin', 0.5, 0],
  ])('rejects %s', (_label, originX, originY) => {
    const { indices, width, height } = image([[1]])
    expect(() => sliceTemplate(indices, width, height, originX, originY)).toThrow(SliceError)
  })

  it('rejects a template running past the east edge rather than wrapping it', () => {
    // Wrapped placement is a coherent feature the wire supports, but it needs a decision about which
    // run is the bbox minimum. Failing loudly beats silently placing pixels across the canvas.
    const { indices, width, height } = image([[1, 2]])
    expect(() => sliceTemplate(indices, width, height, WORLD_PIXELS - 1, 0)).toThrow(/east edge/)
  })

  it('accepts a template ending exactly on the east edge', () => {
    const { indices, width, height } = image([[1, 2]])
    expect(sliceTemplate(indices, width, height, WORLD_PIXELS - 2, 0).bbox.maxX).toBe(WORLD_PIXELS)
  })

  it('rejects a template running past the south edge', () => {
    const { indices, width, height } = image([[1], [2]])
    expect(() => sliceTemplate(indices, width, height, 0, WORLD_PIXELS - 1)).toThrow(/south edge/)
  })
})

describe('boundsOverlap', () => {
  it.each([
    ['identical boxes', { minX: 0, minY: 0, maxX: 10, maxY: 10 }, true],
    ['touching on x only', { minX: 10, minY: 0, maxX: 20, maxY: 10 }, false],
    ['touching on y only', { minX: 0, minY: 10, maxX: 10, maxY: 20 }, false],
    ['overlapping by one pixel', { minX: 9, minY: 9, maxX: 20, maxY: 20 }, true],
    ['disjoint in y, overlapping in x', { minX: 0, minY: 50, maxX: 10, maxY: 60 }, false],
  ])('%s', (_label, other, want) => {
    expect(boundsOverlap({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, other)).toBe(want)
    expect(boundsOverlap(other, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(want)
  })

  it('reads a wrapped box as two ranges', () => {
    // minX > maxX spans the antimeridian, so it meets boxes at both ends of the canvas and misses
    // the middle. Treating it as one range would get all three of these wrong.
    const wrapped = { minX: WORLD_PIXELS - 100, minY: 0, maxX: 100, maxY: 10 }
    expect(boundsOverlap(wrapped, { minX: 0, minY: 0, maxX: 50, maxY: 10 })).toBe(true)
    expect(
      boundsOverlap(wrapped, { minX: WORLD_PIXELS - 50, minY: 0, maxX: WORLD_PIXELS, maxY: 10 }),
    ).toBe(true)
    expect(boundsOverlap(wrapped, { minX: 500, minY: 0, maxX: 600, maxY: 10 })).toBe(false)
  })
})
