// @vitest-environment happy-dom
import { latLngToCanvasPixel, WORLD_PIXELS } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'

const harness = vi.hoisted(() => ({
  current: true,
  movingId: null as string | null,
  afterPng: null as (() => void) | null,
  png: new Blob(['png'], { type: 'image/png' }) as Blob | null,
  opacity: 0.42,
}))

vi.mock('./local-store.js', () => ({
  appearanceOf: () => ({ opacity: harness.opacity }),
  isCurrentTemplate: () => harness.current,
  templateAsPng: async () => {
    harness.afterPng?.()
    return harness.png
  },
}))
vi.mock('./move.js', () => ({ movingId: () => harness.movingId }))

import { templateAsWplace, wplaceFile, wplaceFilename } from './wplace-export.js'

const template = (overrides: Partial<PlacedTemplate> = {}): PlacedTemplate =>
  ({
    id: 'local-template',
    name: 'example.png',
    source: 'image',
    sortOrder: 7,
    originX: WORLD_PIXELS / 2,
    originY: WORLD_PIXELS / 2,
    width: 1000,
    height: 500,
    indices: new Uint8Array(500_000),
    moved: 0,
    opaque: 500_000,
    tiles: new Set(),
    visible: true,
    everPlaced: true,
    appearance: null,
    revision: 1,
    owns: [],
    folderId: null,
    ...overrides,
  }) as PlacedTemplate

beforeEach(() => {
  harness.current = true
  harness.movingId = null
  harness.afterPng = null
  harness.png = new Blob(['png'], { type: 'image/png' })
  harness.opacity = 0.42
})

describe('native wplace export', () => {
  it('emits the editor schema with bounds that project back to the template', () => {
    const source = template()
    const record = wplaceFile(source, 'data:image/png;base64,cG5n', 0.42)

    expect(record).toMatchObject({
      schemaVersion: '1',
      name: 'example.png',
      opacity: 0.42,
      image: { dataUrl: 'data:image/png;base64,cG5n', width: 1000, height: 500 },
      colorMetric: 'lab',
      colorPaletteMode: 'all',
      dithering: false,
      useLegacyColors: false,
      order: 7,
      locked: false,
      hasPlaced: true,
      visible: true,
    })
    expect(latLngToCanvasPixel({ lat: record.bounds.north, lng: record.bounds.west })).toEqual({
      x: source.originX,
      y: source.originY,
    })
    expect(latLngToCanvasPixel({ lat: record.bounds.south, lng: record.bounds.east })).toEqual({
      x: source.originX + source.width,
      y: source.originY + source.height,
    })
  })

  it('embeds the indexed PNG without re-decoding it', async () => {
    const exported = await templateAsWplace(template())
    const record = JSON.parse((await exported?.text()) ?? '{}')

    expect(exported?.type).toBe('application/json')
    expect(record.image.dataUrl).toBe('data:image/png;base64,cG5n')
    expect(record.opacity).toBe(0.42)
  })

  it('refuses an unplaced or stale template', async () => {
    await expect(templateAsWplace(template({ everPlaced: false }))).resolves.toBeNull()
    harness.current = false
    await expect(templateAsWplace(template())).resolves.toBeNull()
  })

  it('refuses to finalize an export if placement starts while encoding', async () => {
    harness.afterPng = () => {
      harness.movingId = 'local-template'
    }

    await expect(templateAsWplace(template())).resolves.toBeNull()
  })

  it('creates safe native filenames', () => {
    expect(wplaceFilename('chapter one.png')).toBe('chapter one.wplace')
    expect(wplaceFilename('bad/name?.png')).toBe('bad_name_.wplace')
    expect(wplaceFilename('.png')).toBe('template.wplace')
  })
})
