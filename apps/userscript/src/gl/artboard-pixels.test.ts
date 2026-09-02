// @vitest-environment happy-dom

import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { expect, it } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import {
  artboardCanvasWriteRect,
  patchArtboardPixels,
  readArtboardPixels,
} from './artboard-pixels.js'

const image = (indices: readonly number[]): ImageData => {
  const data = new Uint8ClampedArray(indices.length * 4)
  for (const [at, index] of indices.entries()) {
    const colour = WPLACE_PALETTE[index]
    if (colour === undefined || index === TRANSPARENT_INDEX) continue
    data.set([...colour.rgb, 255], at * 4)
  }
  return { data, width: indices.length, height: 1, colorSpace: 'srgb' } as ImageData
}

it('reads signed HQ tile canvases back into palette indices', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const layer = document.createElement('div')
  layer.className = 'hq-tile-layer'
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 1
  canvas.style.left = '0px'
  canvas.style.top = '0px'
  canvas.style.width = '4px'
  canvas.style.height = '2px'
  canvas.getContext = (() => ({
    getImageData: () => image([4, 7]),
  })) as unknown as typeof canvas.getContext
  layer.append(canvas)
  frame.append(layer)
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -2, minY: -1, maxX: 2, maxY: 1 },
  }

  expect(readArtboardPixels(active, { originX: -2, originY: -1, width: 4, height: 2 })).toEqual({
    committed: [
      {
        x: -2,
        y: -1,
        width: 2,
        height: 1,
        pixels: new Uint8Array([4, 7]),
        emptyIndex: TRANSPARENT_INDEX,
      },
    ],
    draft: [],
  })
})

it('keeps the HQ draft canvas separate from committed tiles', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const layer = document.createElement('div')
  layer.className = 'hq-tile-layer'
  const committed = document.createElement('canvas')
  committed.width = 2
  committed.height = 1
  committed.style.left = '0px'
  committed.style.top = '0px'
  committed.style.width = '2px'
  committed.style.height = '1px'
  committed.getContext = (() => ({
    getImageData: () => image([4, 7]),
  })) as unknown as typeof committed.getContext
  layer.append(committed)
  const draft = document.createElement('canvas')
  draft.width = 4
  draft.height = 2
  draft.getContext = (() => ({
    getImageData: () =>
      image([
        TRANSPARENT_INDEX,
        2,
        TRANSPARENT_INDEX,
        TRANSPARENT_INDEX,
        TRANSPARENT_INDEX,
        TRANSPARENT_INDEX,
        TRANSPARENT_INDEX,
        TRANSPARENT_INDEX,
      ]),
  })) as unknown as typeof draft.getContext
  frame.append(layer, draft)
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -2, minY: -1, maxX: 2, maxY: 1 },
  }

  const pixels = readArtboardPixels(active, { originX: -2, originY: -1, width: 4, height: 2 })
  expect(pixels.committed).toHaveLength(1)
  expect(pixels.draft).toEqual([
    {
      x: -2,
      y: -1,
      width: 4,
      height: 2,
      pixels: new Uint8Array([255, 2, 255, 255, 255, 255, 255, 255]),
      emptyIndex: 255,
    },
  ])
})

it('patches only the native canvas rectangle Wplace changed', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const layer = document.createElement('div')
  layer.className = 'hq-tile-layer'
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 1
  canvas.style.left = '0px'
  canvas.style.top = '0px'
  canvas.style.width = '2px'
  canvas.style.height = '1px'
  const current = image([4, 7])
  const reads: number[][] = []
  canvas.getContext = (() => ({
    getImageData: (x: number, y: number, width: number, height: number) => {
      reads.push([x, y, width, height])
      return width === 1 ? image([2]) : current
    },
  })) as unknown as typeof canvas.getContext
  layer.append(canvas)
  frame.append(layer)
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -1, minY: 0, maxX: 1, maxY: 1 },
  }
  const geometry = { originX: -1, originY: 0, width: 2, height: 1 }

  expect(readArtboardPixels(active, geometry).committed[0]?.pixels).toEqual(new Uint8Array([4, 7]))
  patchArtboardPixels(canvas, { x: 1, y: 0, width: 1, height: 1 })
  expect(readArtboardPixels(active, geometry).committed[0]?.pixels).toEqual(new Uint8Array([4, 2]))
  expect(reads).toEqual([
    [0, 0, 2, 1],
    [1, 0, 1, 1],
  ])
})

it('maps bounded HQ writes into signed logical coordinates', () => {
  const active = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage: document.createElement('div'),
    frame: document.createElement('div'),
    draftId: null,
    bounds: { minX: -1_000, minY: -1_000, maxX: 1_000, maxY: 1_000 },
  } satisfies ActiveAllianceSurface
  const layer = document.createElement('div')
  layer.className = 'hq-tile-layer'
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  canvas.style.left = '32px'
  canvas.style.top = '64px'
  canvas.style.width = '64px'
  canvas.style.height = '64px'
  layer.append(canvas)
  active.frame.append(layer)

  expect(
    artboardCanvasWriteRect(
      active,
      { originX: -1_000, originY: -1_000, width: 2_000, height: 2_000 },
      canvas,
      { x: 4, y: 5, width: 2, height: 3 },
    ),
  ).toEqual({ x: -964, y: -931, width: 2, height: 3 })
})
