import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const pixels = new Uint8Array(1_000 * 1_000).fill(255)
  pixels[1] = 7
  return {
    cached: true,
    draft: null as Uint8Array | null,
    pixels,
    template: {
      id: 'template',
      name: 'Template',
      originX: 0,
      originY: 0,
      width: 2,
      height: 1,
      indices: new Uint8Array([4, 4]),
      opaque: 2,
      moved: 0,
      visible: true,
      appearance: null,
      owns: [],
      folderId: null,
      tiles: new Map([['0/0', {}]]),
    },
  }
})

vi.mock('../debug.js', () => ({ count: vi.fn() }))
vi.mock('../tile-transform.js', () => ({
  draftPixels: () => harness.draft,
  ensureTilePixels: vi.fn(),
  loadTilePixels: async () => harness.pixels,
  onTilePixel: vi.fn(),
  onTilePixelsAvailable: vi.fn(),
  onTilePixels: vi.fn(),
  onTilePixelsEvicted: vi.fn(),
  tilePixels: () => (harness.cached ? harness.pixels : null),
  UNPAINTED: 255,
}))
vi.mock('./colour-filter.js', () => ({ claimedHiddenFor: () => [] }))
vi.mock('./local-store.js', () => ({
  appearanceOf: () => ({ markUnpainted: false }),
  displayTemplates: () => [harness.template],
  isTemplateVisible: () => true,
  onLocalChange: vi.fn(),
  templateTileKeys: (template: typeof harness.template) => template.tiles.keys(),
}))
vi.mock('./mismatch-worker.js', () => ({
  forgetInWorker: vi.fn(),
  hasWorker: () => false,
  scanInWorker: vi.fn(),
}))

beforeEach(() => {
  harness.cached = true
  harness.draft = null
  harness.pixels.fill(255)
  harness.pixels[1] = 7
})

describe('per-colour navigation', () => {
  it('finds the nearest loaded blank or mismatched pixel for the desired overlay colour', async () => {
    const { nearestColourTarget, nearestLoadedColourTarget } = await import('./mismatch.js')

    expect(nearestLoadedColourTarget(4, 'unpainted', { x: 10, y: 0 })).toEqual({
      templateId: 'template',
      x: 0,
      y: 0,
      kind: 'unpainted',
    })
    expect(nearestLoadedColourTarget(4, 'mismatched', { x: 10, y: 0 })).toEqual({
      templateId: 'template',
      x: 1,
      y: 0,
      kind: 'mismatched',
    })
    expect(nearestLoadedColourTarget(5, 'unpainted', { x: 10, y: 0 })).toBeNull()

    harness.cached = false
    await expect(nearestColourTarget(4, 'unpainted', { x: 10, y: 0 })).resolves.toEqual({
      templateId: 'template',
      x: 0,
      y: 0,
      kind: 'unpainted',
    })
  })

  it('does not navigate to a blank canvas pixel already covered by the correct draft', async () => {
    harness.pixels.fill(255)
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.draft[0] = 4
    const { nearestLoadedColourTarget } = await import('./mismatch.js')

    expect(nearestLoadedColourTarget(4, 'unpainted', { x: 0, y: 0 })).toEqual({
      templateId: 'template',
      x: 1,
      y: 0,
      kind: 'unpainted',
    })
  })
})
