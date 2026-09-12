import { regionShapePixels, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { eraseFromRaster, mergeRasters, PixelSet, rasterTouches } from './claim-raster.js'

describe('pixel sets', () => {
  it('stamps a one-pixel pencil along a line and packs it into a raster shape', () => {
    const set = new PixelSet()
    set.line({ x: 10, y: 10 }, { x: 14, y: 12 }, 1)
    expect(set.size).toBe(5)
    const shape = set.shape()
    expect(shape).toMatchObject({ kind: 'pixels', x: 10, y: 10, w: 5, h: 3 })
    const pixels = regionShapePixels(shape as NonNullable<typeof shape>)
    expect(pixels.count).toBe(5)
  })

  it('stamps a round tip for wider pencils', () => {
    const set = new PixelSet()
    set.stamp(20, 20, 5)
    expect(set.has(20, 20)).toBe(true)
    expect(set.has(22, 20)).toBe(true)
    expect(set.has(22, 22)).toBe(false)
    expect(set.has(23, 20)).toBe(false)
  })

  it('drops pixels past the canvas edge and refuses a box too large to hold', () => {
    const edge = new PixelSet()
    edge.stamp(WORLD_PIXELS - 1, WORLD_PIXELS - 1, 5)
    expect(edge.has(WORLD_PIXELS - 1, WORLD_PIXELS - 1)).toBe(true)
    expect(edge.has(WORLD_PIXELS, WORLD_PIXELS - 1)).toBe(false)
    const shape = edge.shape()
    expect(shape).not.toBeNull()
    expect(shape?.kind === 'pixels' ? shape.x + shape.w : 0).toBe(WORLD_PIXELS)
    const diagonal = new PixelSet()
    diagonal.add(0, 0)
    diagonal.add(1_000, 1_000)
    expect(diagonal.pixels()).toBeNull()
    expect(diagonal.shape()).toBeNull()
  })

  it('merges two rasters and erases from one', () => {
    const a = new PixelSet()
    a.line({ x: 0, y: 0 }, { x: 3, y: 0 }, 1)
    const b = new PixelSet()
    b.line({ x: 3, y: 0 }, { x: 3, y: 3 }, 1)
    const merged = mergeRasters(
      a.shape() as NonNullable<ReturnType<PixelSet['shape']>>,
      b.shape() as NonNullable<ReturnType<PixelSet['shape']>>,
    )
    expect(merged).toMatchObject({ kind: 'pixels', x: 0, y: 0, w: 4, h: 4 })
    expect(regionShapePixels(merged as NonNullable<typeof merged>).count).toBe(7)
    const eraser = new PixelSet()
    eraser.stamp(3, 1, 1)
    eraser.stamp(3, 2, 1)
    expect(rasterTouches(merged as NonNullable<typeof merged>, eraser)).toBe(true)
    const cut = eraseFromRaster(merged as NonNullable<typeof merged>, eraser)
    expect(regionShapePixels(cut as NonNullable<typeof cut>).count).toBe(5)
    const far = new PixelSet()
    far.stamp(50, 50, 1)
    expect(eraseFromRaster(merged as NonNullable<typeof merged>, far)).toBe(merged)
    const all = new PixelSet()
    all.line({ x: 0, y: 0 }, { x: 3, y: 0 }, 1)
    all.line({ x: 3, y: 0 }, { x: 3, y: 3 }, 1)
    expect(eraseFromRaster(merged as NonNullable<typeof merged>, all)).toBeNull()
  })
})
