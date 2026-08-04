import { describe, expect, it } from 'vitest'
import { parseTileKey, tileKey } from './tiles.js'

describe('tileKey', () => {
  it('round-trips through parseTileKey', () => {
    expect(parseTileKey(tileKey({ x: 325, y: 1782 }))).toEqual({ x: 325, y: 1782 })
  })
})

describe('parseTileKey', () => {
  it('parses a well-formed key', () => {
    expect(parseTileKey('325/1782')).toEqual({ x: 325, y: 1782 })
  })

  it('rejects non-integer coordinates', () => {
    // Tile coordinates index a grid. A fractional one means whatever produced it was wrong, and
    // silently flooring it would put template chunks on the wrong tile.
    expect(parseTileKey('325.5/1782')).toBeNull()
  })

  it.each(['', '325', '325/', '/1782', '325/1782/0', 'a/b'])('rejects %o', (input) => {
    expect(parseTileKey(input)).toBeNull()
  })
})
