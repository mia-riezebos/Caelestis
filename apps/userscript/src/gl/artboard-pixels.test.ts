// @vitest-environment happy-dom

import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { expect, it } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { readArtboardPixels } from './artboard-pixels.js'

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

  expect(readArtboardPixels(active, { originX: -2, originY: -1, width: 4, height: 2 })).toEqual([
    { x: -2, y: -1, width: 2, height: 1, pixels: new Uint8Array([4, 7]) },
  ])
})
