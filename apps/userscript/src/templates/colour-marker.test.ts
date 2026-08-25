import { TILE_SIZE, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { beginColourMarkerFrame, colourMarksIn, endColourMarkerFrame } from './colour-marker.js'

describe('selected-colour marker coordinates', () => {
  it('returns only selected pixels inside the requested tile', () => {
    const template = {
      indices: new Uint8Array([2, 4, 2, 3, 4, 4]),
      originX: TILE_SIZE - 1,
      originY: 10,
      width: 3,
      height: 2,
    }

    expect([...colourMarksIn(template, { x: 1, y: 0 }, 4)]).toEqual([
      TILE_SIZE,
      10,
      4,
      TILE_SIZE,
      11,
      4,
      TILE_SIZE + 1,
      11,
      4,
    ])
  })

  it('folds wrapped source columns into the western tile', () => {
    const template = {
      indices: new Uint8Array([7, 1, 7]),
      originX: WORLD_PIXELS - 2,
      originY: 0,
      width: 3,
      height: 1,
      wrapX: true,
    }

    expect([...colourMarksIn(template, { x: 0, y: 0 }, 7)]).toEqual([0, 0, 7])
  })

  it('keeps every selected-colour answer requested by one visible frame', () => {
    const width = TILE_SIZE * 129
    const indices = new Uint8Array(width)
    for (let tile = 0; tile < 129; tile++) indices[tile * TILE_SIZE] = 4
    const template = { indices, originX: 0, originY: 0, width, height: 1 }
    beginColourMarkerFrame()
    const first = colourMarksIn(template, { x: 0, y: 0 }, 4)
    for (let tile = 1; tile < 129; tile++) colourMarksIn(template, { x: tile, y: 0 }, 4)

    expect(colourMarksIn(template, { x: 0, y: 0 }, 4)).toBe(first)
    endColourMarkerFrame()
  })

  it('drops selected-colour answers outside the next viewport frame', () => {
    const template = {
      indices: new Uint8Array(TILE_SIZE + 1).fill(4),
      originX: 0,
      originY: 0,
      width: TILE_SIZE + 1,
      height: 1,
    }
    beginColourMarkerFrame()
    colourMarksIn(template, { x: 0, y: 0 }, 4)
    const offscreen = colourMarksIn(template, { x: 1, y: 0 }, 4)
    endColourMarkerFrame()

    beginColourMarkerFrame()
    colourMarksIn(template, { x: 0, y: 0 }, 4)
    endColourMarkerFrame()

    beginColourMarkerFrame()
    expect(colourMarksIn(template, { x: 1, y: 0 }, 4)).not.toBe(offscreen)
    endColourMarkerFrame()
  })
})
