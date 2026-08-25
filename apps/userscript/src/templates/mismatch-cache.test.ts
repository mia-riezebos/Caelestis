import { decodeMismatchMask, encodeMismatchMask, type MismatchMask, WRONG } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'

const harness = vi.hoisted(() => ({
  pixels: new Uint8Array(1_000 * 1_000).fill(1),
  templates: [] as PlacedTemplate[],
  serverMask: null as MismatchMask | null,
}))

vi.mock('../debug.js', () => ({ count: vi.fn() }))
vi.mock('../tile-transform.js', () => ({
  draftPixels: () => null,
  ensureTilePixels: vi.fn(),
  loadTilePixels: async () => harness.pixels,
  onTilePixel: vi.fn(),
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
  appearanceOf: () => ({ markUnpainted: false }),
  displayTemplates: () => harness.templates,
  isTemplateVisible: () => true,
  onLocalChange: vi.fn(),
  templateTileKeys: (template: PlacedTemplate) => template.tiles.keys(),
}))
vi.mock('./mismatch-worker.js', () => ({
  forgetInWorker: vi.fn(),
  hasWorker: () => false,
  scanInWorker: vi.fn(),
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
})

describe('visible mismatch answer retention', () => {
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
    expect(mismatchesIn(serverTemplate, { x: 0, y: 0 })).toHaveLength(129 * 3)
    endMismatchFrame()
  })

  it('exposes unpainted work to selected-colour markers when magenta excludes it', async () => {
    const selected = template(201)
    harness.pixels[0] = 255
    const { beginMismatchFrame, disagreementsIn, endMismatchFrame, mismatchesIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(0)
    expect(disagreementsIn(selected, { x: 0, y: 0 })).toEqual(new Float32Array([0, 0, 0]))
    endMismatchFrame()
  })
})
