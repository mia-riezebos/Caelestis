// @vitest-environment happy-dom

import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { nativePixelAt } from '../native-pixels.js'
import { artboardTemplateProgress } from './artboard-markers.js'
import {
  artboardCanvasWriteRect,
  patchArtboardPixels,
  readArtboardPixels,
  refreshArtboardPixels,
  resetArtboardPixelCache,
} from './artboard-pixels.js'

afterEach(() => {
  resetArtboardPixelCache()
  vi.restoreAllMocks()
})

const image = (indices: readonly number[]): ImageData => {
  const data = new Uint8ClampedArray(indices.length * 4)
  for (const [at, index] of indices.entries()) {
    const colour = WPLACE_PALETTE[index]
    if (colour === undefined || index === TRANSPARENT_INDEX) continue
    data.set([...colour.rgb, 255], at * 4)
  }
  return { data, width: indices.length, height: 1, colorSpace: 'srgb' } as ImageData
}

const crosshairImage = (width: number, height: number, cellX: number, cellY: number): ImageData => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = cellY * 10; y < (cellY + 1) * 10; y++) {
    for (let x = cellX * 10; x < (cellX + 1) * 10; x++) data[(y * width + x) * 4 + 3] = 255
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData
}

const hqSnapshot = (
  tileSize: number,
  tiles: readonly {
    readonly x: number
    readonly y: number
    readonly version: number
    readonly pixels: readonly number[]
  }[],
): ArrayBuffer => {
  const buffer = new ArrayBuffer(19 + tiles.length * (12 + tileSize * tileSize))
  const bytes = new Uint8Array(buffer)
  bytes.set(new TextEncoder().encode('WHQS1'))
  const view = new DataView(buffer)
  view.setUint16(5, tileSize, true)
  view.setBigInt64(7, 1n, true)
  view.setUint16(15, tiles.length, true)
  let at = 19
  for (const tile of tiles) {
    view.setInt16(at, tile.x, true)
    view.setInt16(at + 2, tile.y, true)
    view.setBigInt64(at + 4, BigInt(tile.version), true)
    bytes.set(tile.pixels, at + 12)
    at += 12 + tileSize * tileSize
  }
  return buffer
}

it('retains complete HQ bounds after loading the bounded snapshot', async () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: 0, minY: 0, maxX: 4, maxY: 2 },
  }
  const geometry = { originX: 0, originY: 0, width: 4, height: 2 }
  const response = (body: ArrayBuffer): Response =>
    new Response(body, {
      headers: { 'content-type': 'application/x-wplace-alliance-hq-snapshot' },
    })
  const fetch = vi
    .spyOn(window, 'fetch')
    .mockResolvedValueOnce(
      response(hqSnapshot(2, [{ x: 0, y: 0, version: 7, pixels: [5, 0, 0, 0] }])),
    )
    .mockResolvedValueOnce(response(hqSnapshot(2, [])))

  await refreshArtboardPixels(active, geometry)
  const pixels = readArtboardPixels(active, geometry)
  const template = {
    originX: 0,
    originY: 0,
    width: 4,
    height: 2,
    indices: new Uint8Array(8).fill(4),
  }

  expect(artboardTemplateProgress(template, pixels)).toEqual({
    completed: 1,
    mismatched: 0,
    unpainted: 7,
    known: 8,
    total: 8,
  })
  expect(fetch).toHaveBeenCalledWith(
    'https://backend.wplace.live/alliances/535245/headquarters/snapshot',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ minX: 0, minY: 0, maxX: 3, maxY: 1, knownTiles: [] }),
    }),
  )

  await refreshArtboardPixels(active, geometry)
  expect(fetch).toHaveBeenLastCalledWith(
    'https://backend.wplace.live/alliances/535245/headquarters/snapshot',
    expect.objectContaining({
      body: JSON.stringify({
        minX: 0,
        minY: 0,
        maxX: 3,
        maxY: 1,
        knownTiles: [{ x: 0, y: 0, version: 7 }],
      }),
    }),
  )
  expect(artboardTemplateProgress(template, readArtboardPixels(active, geometry)).known).toBe(8)
})

it('does not let a late HQ snapshot replace a newer native tile write', async () => {
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
  const current = TRANSPARENT_INDEX
  canvas.getContext = (() => ({
    getImageData: () => image([current, TRANSPARENT_INDEX]),
  })) as unknown as typeof canvas.getContext
  layer.append(canvas)
  frame.append(layer)
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
  }
  const geometry = { originX: 0, originY: 0, width: 2, height: 1 }
  const response = (body: ArrayBuffer): Response =>
    new Response(body, {
      headers: { 'content-type': 'application/x-wplace-alliance-hq-snapshot' },
    })
  let finishLate!: (response: Response) => void
  const late = new Promise<Response>((resolve) => {
    finishLate = resolve
  })
  const fetch = vi
    .spyOn(window, 'fetch')
    .mockResolvedValueOnce(
      response(hqSnapshot(2, [{ x: 0, y: 0, version: 1, pixels: [0, 0, 0, 0] }])),
    )
    .mockReturnValueOnce(late)
    .mockResolvedValueOnce(
      response(hqSnapshot(2, [{ x: 0, y: 0, version: 3, pixels: [0, 0, 0, 0] }])),
    )

  await refreshArtboardPixels(active, geometry)
  readArtboardPixels(active, geometry)
  const pending = refreshArtboardPixels(active, geometry)
  patchArtboardPixels(active, geometry, canvas, { x: 0, y: 0, width: 1, height: 1 })
  expect(nativePixelAt(readArtboardPixels(active, geometry), 0, 0)).toEqual({
    index: TRANSPARENT_INDEX,
    source: 'committed',
  })
  layer.remove()
  finishLate(response(hqSnapshot(2, [{ x: 0, y: 0, version: 2, pixels: [7, 0, 0, 0] }])))
  await pending

  expect(fetch).toHaveBeenCalledTimes(3)
  expect(nativePixelAt(readArtboardPixels(active, geometry), 0, 0)).toEqual({
    index: TRANSPARENT_INDEX,
    source: 'committed',
  })
})

it.each([
  ['alliance-picture', 64, 64],
  ['alliance-banner', 384, 128],
] as const)('treats the complete %s canvas as known', (kind, width, height) => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext = (() => ({
    getImageData: () => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
      colorSpace: 'srgb',
    }),
  })) as unknown as typeof canvas.getContext
  frame.append(canvas)
  stage.append(frame)
  const active: ActiveAllianceSurface = {
    surface: { kind, allianceId: 535_245 },
    stage,
    frame,
    draftId: 129,
    bounds: null,
  }

  const pixels = readArtboardPixels(active, { originX: 0, originY: 0, width, height })
  expect(pixels.committed).toHaveLength(1)
  expect(pixels.committed[0]?.pixels).toHaveLength(width * height)
  expect(nativePixelAt(pixels, width - 1, height - 1)).toEqual({
    index: TRANSPARENT_INDEX,
    source: 'committed',
  })
})

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

it('uses alliance crosshairs to preserve an explicit transparent draft', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const draft = document.createElement('canvas')
  draft.width = 2
  draft.height = 1
  draft.getContext = (() => ({
    getImageData: () => image([TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
  })) as unknown as typeof draft.getContext
  frame.append(draft)

  const crosshairLayer = document.createElement('div')
  crosshairLayer.className = 'paint-crosshair-layer'
  const crosshair = document.createElement('canvas')
  crosshair.className = 'paint-crosshair-tile'
  crosshair.width = 20
  crosshair.height = 10
  crosshair.style.left = '0px'
  crosshair.style.top = '0px'
  crosshair.style.width = '2px'
  crosshair.style.height = '1px'
  crosshair.getContext = (() => ({
    getImageData: () => crosshairImage(20, 10, 1, 0),
  })) as unknown as typeof crosshair.getContext
  crosshairLayer.append(crosshair)
  stage.append(frame, crosshairLayer)

  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -1, minY: 0, maxX: 1, maxY: 1 },
  }
  const geometry = { originX: -1, originY: 0, width: 2, height: 1 }
  const pixels = readArtboardPixels(active, geometry)

  expect(nativePixelAt(pixels, -1, 0)).toBeNull()
  expect(nativePixelAt(pixels, 0, 0)).toEqual({ index: TRANSPARENT_INDEX, source: 'draft' })
  expect(
    artboardCanvasWriteRect(active, geometry, crosshair, { x: 10, y: 0, width: 10, height: 10 }),
  ).toEqual({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  })
})

it('patches only the crosshair cells Wplace changed', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  const draft = document.createElement('canvas')
  draft.width = 2
  draft.height = 1
  draft.getContext = (() => ({
    getImageData: () => image([TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
  })) as unknown as typeof draft.getContext
  frame.append(draft)

  const crosshairLayer = document.createElement('div')
  crosshairLayer.className = 'paint-crosshair-layer'
  const crosshair = document.createElement('canvas')
  crosshair.className = 'paint-crosshair-tile'
  crosshair.width = 20
  crosshair.height = 10
  crosshair.style.left = '0px'
  crosshair.style.top = '0px'
  crosshair.style.width = '2px'
  crosshair.style.height = '1px'
  const reads: number[][] = []
  crosshair.getContext = (() => ({
    getImageData: (x: number, y: number, width: number, height: number) => {
      reads.push([x, y, width, height])
      return crosshairImage(width, height, width === 20 ? 1 : 0, 0)
    },
  })) as unknown as typeof crosshair.getContext
  crosshairLayer.append(crosshair)
  stage.append(frame, crosshairLayer)

  const active: ActiveAllianceSurface = {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: -1, minY: 0, maxX: 1, maxY: 1 },
  }
  const geometry = { originX: -1, originY: 0, width: 2, height: 1 }

  expect(nativePixelAt(readArtboardPixels(active, geometry), -1, 0)).toBeNull()
  expect(nativePixelAt(readArtboardPixels(active, geometry), 0, 0)).toEqual({
    index: TRANSPARENT_INDEX,
    source: 'draft',
  })
  patchArtboardPixels(active, geometry, crosshair, { x: 0, y: 0, width: 10, height: 10 })
  expect(nativePixelAt(readArtboardPixels(active, geometry), -1, 0)).toEqual({
    index: TRANSPARENT_INDEX,
    source: 'draft',
  })
  expect(reads).toEqual([
    [0, 0, 20, 10],
    [0, 0, 10, 10],
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
  patchArtboardPixels(active, geometry, canvas, { x: 1, y: 0, width: 1, height: 1 })
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
