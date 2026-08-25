import { TILE_SIZE, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { colourMarksIn } from './colour-marker.js'

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
})
