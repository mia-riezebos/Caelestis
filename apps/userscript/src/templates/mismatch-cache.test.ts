import { decodeMismatchMask, encodeMismatchMask, type MismatchMask, WRONG } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'
import type { ScanOutcome } from './mismatch-scan.js'

const harness = vi.hoisted(() => ({
  pixels: new Uint8Array(1_000 * 1_000).fill(1),
  templates: [] as PlacedTemplate[],
  serverMask: null as MismatchMask | null,
  workerAvailable: false,
  markersEnabled: true,
  workerScan: vi.fn<(...args: unknown[]) => Promise<ScanOutcome | null>>(),
  onTilePixels: vi.fn(),
  onTilePixelsEvicted: vi.fn(),
}))

vi.mock('../debug.js', () => ({ count: vi.fn() }))
vi.mock('../tile-transform.js', () => ({
  draftPixels: () => null,
  ensureTilePixels: vi.fn(),
  loadTilePixels: async () => harness.pixels,
  onTilePixel: vi.fn(),
  onTilePixels: harness.onTilePixels,
  onTilePixelsEvicted: harness.onTilePixelsEvicted,
  tilePixels: () => harness.pixels,
  UNPAINTED: 255,
}))
vi.mock('../server-mismatch.js', () => ({
  beginServerMismatchFrame: vi.fn(),
  endServerMismatchFrame: vi.fn(),
  onServerMismatchesChanged: vi.fn(),
  serverMismatchMaskFor: () => harness.serverMask,
}))
vi.mock('./colour-filter.js', () => ({ claimedHiddenFor: () => [] }))
vi.mock('./local-store.js', () => ({
  appearanceOf: () => ({
    markMismatch: harness.markersEnabled,
    markSelectedColour: false,
    markUnpainted: false,
  }),
  displayTemplates: () => harness.templates,
  isTemplateVisible: () => true,
  onLocalChange: vi.fn(),
  templateTileKeys: (template: PlacedTemplate) => template.tiles.keys(),
}))
vi.mock('./mismatch-worker.js', () => ({
  forgetInWorker: vi.fn(),
  hasWorker: () => harness.workerAvailable,
  scanInWorker: (...args: unknown[]) => harness.workerScan(...args),
}))

const template = (index: number): PlacedTemplate => ({
  id: `template-${index}`,
  name: `Template ${index}`,
  source: 'image',
  originX: 0,
  originY: 0,
  width: 1,
  height: 1,
  indices: new Uint8Array([0]),
  moved: 0,
  opaque: 1,
  tiles: new Map([['0/0', { levels: [] }]]),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 1,
  owns: [],
  folderId: null,
})

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(performance, 'now').mockReturnValue(0)
  harness.templates = Array.from({ length: 129 }, (_, index) => template(index))
  harness.pixels.fill(1)
  harness.serverMask = null
  harness.workerAvailable = false
  harness.markersEnabled = true
  harness.workerScan.mockReset()
  harness.onTilePixels.mockReset()
  harness.onTilePixelsEvicted.mockReset()
})

describe('visible mismatch answer retention', () => {
  it('requests pixel capture only for intersecting visible template tiles', async () => {
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(true)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(true)
    expect(wantsTilePixels({ x: 1, y: 0 })).toBe(false)
  })

  it('does not request pixel capture when every template has markers disabled', async () => {
    harness.markersEnabled = false
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(false)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(false)
  })

  it('keeps every answer requested by one visible frame', async () => {
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    beginMismatchFrame()
    const first = mismatchesIn(harness.templates[0] as PlacedTemplate, { x: 0, y: 0 })
    for (const candidate of harness.templates.slice(1)) {
      mismatchesIn(candidate, { x: 0, y: 0 })
    }

    expect(mismatchesIn(harness.templates[0] as PlacedTemplate, { x: 0, y: 0 })).toBe(first)
    endMismatchFrame()
  })

  it('drops answers that the next viewport frame does not request', async () => {
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    const firstTemplate = harness.templates[0] as PlacedTemplate
    const offscreenTemplate = harness.templates[1] as PlacedTemplate
    beginMismatchFrame()
    mismatchesIn(firstTemplate, { x: 0, y: 0 })
    const offscreen = mismatchesIn(offscreenTemplate, { x: 0, y: 0 })
    endMismatchFrame()

    beginMismatchFrame()
    mismatchesIn(firstTemplate, { x: 0, y: 0 })
    endMismatchFrame()

    beginMismatchFrame()
    expect(mismatchesIn(offscreenTemplate, { x: 0, y: 0 })).not.toBe(offscreen)
    endMismatchFrame()
  })

  it('draws every server-classified mismatch beyond the old 128-answer cap', async () => {
    const serverTemplate = {
      ...template(200),
      width: 129,
      indices: new Uint8Array(129),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.pixels.fill(0)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask(
        { left: 0, top: 0, width: 129, height: 1 },
        new Uint8Array(129).fill(WRONG),
      ),
    )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')

    beginMismatchFrame()
    expect(mismatchesIn(serverTemplate, { x: 0, y: 0 })).toHaveLength(129)
    endMismatchFrame()
  })

  it('expands a server mask asynchronously when the worker is available', async () => {
    const serverTemplate = {
      ...template(202),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    harness.workerAvailable = true
    let finish!: (outcome: ScanOutcome) => void
    harness.workerScan.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')

    beginMismatchFrame()
    expect(mismatchesIn(serverTemplate, { x: 0, y: 0 })).toBeNull()
    expect(harness.workerScan).toHaveBeenCalledOnce()
    expect(harness.workerScan.mock.calls[0]?.[0]).toMatchObject({ kind: 'mask' })
    endMismatchFrame()

    finish({
      wrong: new Uint32Array([0]),
      unpainted: new Uint32Array(0),
      asserted: 1,
      completed: 0,
      mismatched: 1,
      progressUnpainted: 0,
      progressAsserted: 1,
      progressByColour: new Uint32Array([0, 0, 1, 0]),
    })
    await vi.waitFor(() => {
      beginMismatchFrame()
      expect(mismatchesIn(serverTemplate, { x: 0, y: 0 })).toEqual(new Uint32Array([0]))
      endMismatchFrame()
    })
  })

  it('exposes unpainted work to selected-colour markers when magenta excludes it', async () => {
    const selected = template(201)
    harness.pixels[0] = 255
    const { beginMismatchFrame, disagreementsIn, endMismatchFrame, mismatchesIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(0)
    expect(disagreementsIn(selected, { x: 0, y: 0 })).toEqual(new Uint32Array([0]))
    endMismatchFrame()
  })

  it('invalidates a busy tile once instead of patching every announced pixel', async () => {
    const selected = template(203)
    harness.templates = [selected]
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()

    harness.workerAvailable = true
    harness.workerScan.mockReturnValueOnce(new Promise(() => undefined))
    const listener = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined
    listener?.({ x: 0, y: 0 }, Array.from({ length: 33 }, () => [0, 0, 1]).flat())

    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()
    expect(harness.workerScan).toHaveBeenCalledOnce()
  })

  it('uses newly captured pixels instead of a superseded server mask after a busy tile update', async () => {
    const selected = {
      ...template(204),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()

    harness.pixels.fill(0)
    harness.workerAvailable = true
    harness.workerScan.mockReturnValueOnce(new Promise(() => undefined))
    const listener = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined
    listener?.({ x: 0, y: 0 }, Array.from({ length: 33 }, () => [0, 0, 0]).flat())

    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()
    expect(harness.workerScan.mock.calls[0]?.[0]).toMatchObject({ kind: 'pixels' })

    beginMismatchFrame()
    endMismatchFrame()
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    harness.workerAvailable = false
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(0)
    endMismatchFrame()

    const pixelsEvicted = harness.onTilePixelsEvicted.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }) => void)
      | undefined
    pixelsEvicted?.({ x: 0, y: 0 })
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()
  })
})
