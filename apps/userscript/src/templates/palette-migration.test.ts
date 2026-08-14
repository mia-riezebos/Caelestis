import { describe, expect, it } from 'vitest'
import {
  remapPaletteColours,
  remapPaletteIndices,
  remapStoredAppearance,
} from './palette-migration.js'

describe('palette persistence migration', () => {
  it('applies the recovered old-to-current permutation', () => {
    expect([...remapPaletteIndices(Uint8Array.from([17, 18, 19, 35, 48, 54, 57, 60]))]).toEqual([
      19, 17, 18, 36, 52, 35, 60, 57,
    ])
  })

  it('keeps the 64 persisted palette entries a bijection', () => {
    const migrated = [...remapPaletteIndices(Uint8Array.from({ length: 64 }, (_, index) => index))]
    expect(new Set(migrated).size).toBe(64)
    expect([...migrated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    )
  })

  it('leaves non-palette sentinels unchanged', () => {
    expect([...remapPaletteIndices(Uint8Array.from([64, 127, 255]))]).toEqual([64, 127, 255])
  })

  it('remaps and deduplicates hidden colour lists', () => {
    expect(remapPaletteColours([17, 19, 17, 54])).toEqual([19, 18, 35])
  })

  it('rewrites only the hidden colours in a stored appearance', () => {
    const stored = { size: 0.5, hiddenColours: [35, 54] }
    expect(remapStoredAppearance(stored)).toEqual({ size: 0.5, hiddenColours: [36, 35] })
    expect(stored.hiddenColours).toEqual([35, 54])
  })
})
