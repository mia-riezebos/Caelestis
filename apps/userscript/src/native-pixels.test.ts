import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { type NativePixelSnapshot, nativePixelAt, nativePixelWindow } from './native-pixels.js'

const snapshot: NativePixelSnapshot = {
  committed: [
    {
      x: -1,
      y: 2,
      width: 3,
      height: 1,
      pixels: new Uint8Array([4, 255, 7]),
      emptyIndex: 255,
    },
  ],
  draft: [
    {
      x: -1,
      y: 2,
      width: 3,
      height: 1,
      pixels: new Uint8Array([255, 2, 255]),
      emptyIndex: 255,
      present: new Uint8Array([0, 1, 1]),
    },
  ],
}

describe('native pixel snapshots', () => {
  it('keeps unknown pixels distinct from known unpainted pixels', () => {
    const pixels = nativePixelWindow(snapshot, { x: -2, y: 2, width: 5, height: 1 })

    expect([...pixels.indices]).toEqual([
      TRANSPARENT_INDEX,
      4,
      2,
      TRANSPARENT_INDEX,
      TRANSPARENT_INDEX,
    ])
    expect([...pixels.known]).toEqual([0, 1, 1, 1, 0])
    expect([...pixels.drafted]).toEqual([0, 0, 1, 1, 0])
  })

  it('lets explicit transparent drafts override committed art', () => {
    expect(nativePixelAt(snapshot, 1, 2)).toEqual({
      index: TRANSPARENT_INDEX,
      source: 'draft',
    })
    expect(nativePixelAt(snapshot, 1, 2, false)).toEqual({ index: 7, source: 'committed' })
  })

  it('returns null outside every known native region', () => {
    expect(nativePixelAt(snapshot, 20, 20)).toBeNull()
  })
})
