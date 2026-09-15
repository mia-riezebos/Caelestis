import { TRANSPARENT_INDEX, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RenderScene } from '../src/gl/render-scene.js'
import { installMapCapture, releaseMapCapture } from '../src/map-handle.js'
import { DEFAULT_APPEARANCE } from '../src/templates/appearance.js'
import { compositeCommittedArtwork } from '../src/templates/current-artwork.js'
import { draftedPixelsIn } from '../src/templates/drafted.js'
import type { PlacedTemplate } from '../src/templates/local-store.js'
import { markLocalX, markLocalY, markWanted } from '../src/templates/mismatch-marks.js'
import { type PixelScanJob, scanTile } from '../src/templates/mismatch-scan.js'

const UNPAINTED = 255

type DraftRenderer = {
  readonly tiles: Map<string, { readonly annotations: Uint8Array }>
  markDirty: (key: string) => unknown
}

afterEach(() => {
  releaseMapCapture()
})

const marks = (value: Uint32Array) =>
  Array.from(value, (mark) => ({
    x: markLocalX(mark),
    y: markLocalY(mark),
    wanted: markWanted(mark),
  }))

const tileJob = (overrides: Partial<PixelScanJob> = {}): PixelScanJob => ({
  kind: 'pixels',
  templateKey: 'pixel-contract',
  indices: null,
  width: 3,
  height: 3,
  originX: 0,
  originY: 0,
  tileX: 0,
  tileY: 0,
  tileSize: 3,
  bandTop: 0,
  draft: null,
  server: null,
  ignored: [TRANSPARENT_INDEX, UNPAINTED],
  transparent: TRANSPARENT_INDEX,
  unpainted: UNPAINTED,
  ...overrides,
})

const template = (overrides: Partial<PlacedTemplate> = {}): PlacedTemplate => ({
  id: 'pixel-contract',
  name: 'Pixel contract',
  source: 'image',
  originX: 10,
  originY: 20,
  width: 3,
  height: 1,
  indices: new Uint8Array([5, 6, 7]),
  moved: 0,
  opaque: 3,
  tiles: new Set(),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 0,
  owns: [],
  folderId: null,
  ...overrides,
})

describe('pixel accounting contracts', () => {
  it('keeps display filters out of progress while omitting their mismatch markers', () => {
    const wanted = new Uint8Array([TRANSPARENT_INDEX, 5, 6, 5, 6, 7, 8, 5, 6])
    const outcome = scanTile(
      tileJob({
        server: new Uint8Array([1, 5, UNPAINTED, UNPAINTED, 6, 8, 8, 2, UNPAINTED]),
        ignored: [TRANSPARENT_INDEX, UNPAINTED, 6],
      }),
      wanted,
    )

    expect(marks(outcome.wrong)).toEqual([
      { x: 2, y: 1, wanted: 7 },
      { x: 1, y: 2, wanted: 5 },
    ])
    expect(marks(outcome.unpainted)).toEqual([{ x: 0, y: 1, wanted: 5 }])
    expect(outcome.asserted).toBe(5)
    expect(outcome).toMatchObject({
      completed: 3,
      mismatched: 2,
      progressUnpainted: 3,
      progressAsserted: 8,
    })
    expect(Array.from(outcome.progressByColour)).toEqual([
      5, 1, 1, 1, 6, 1, 0, 2, 7, 0, 1, 0, 8, 1, 0, 0,
    ])
  })

  it('treats a transparent native draft as a wrong placement over matching committed art', () => {
    const outcome = scanTile(
      tileJob({
        width: 1,
        height: 1,
        tileSize: 1,
        server: new Uint8Array([5]),
        draft: new Uint8Array([TRANSPARENT_INDEX]),
      }),
      new Uint8Array([5]),
    )

    expect(marks(outcome.wrong)).toEqual([{ x: 0, y: 0, wanted: 5 }])
    expect(outcome).toMatchObject({
      completed: 0,
      mismatched: 1,
      progressUnpainted: 0,
      progressAsserted: 1,
    })
  })

  it('removes a transparent draft from the cached crosshair occupancy after Wplace marks it dirty', () => {
    const annotations = new Uint8Array(200 * 200)
    annotations[0] = 1
    const renderer: DraftRenderer = {
      tiles: new Map([['paint-crosshair-0,0', { annotations }]]),
      markDirty: () => {},
    }
    const map = {
      flyTo: () => {},
      getZoom: () => 10,
      style: {
        _layers: {
          'paint-crosshair-annotations': { implementation: renderer },
        },
      },
    }
    installMapCapture()
    Object.assign(map, { _canvasContainer: document.createElement('div') })

    expect(draftedPixelsIn({ x: 0, y: 0 }, 200)).toEqual([0])
    annotations[0] = 0
    renderer.markDirty('paint-crosshair-0,0')
    expect(draftedPixelsIn({ x: 0, y: 0 }, 200)).toEqual([])
  })

  it('uses committed artwork where known and preserves template pixels through committed transparency', () => {
    const artwork = compositeCommittedArtwork(template(), {
      committed: [
        {
          x: 10,
          y: 20,
          width: 3,
          height: 1,
          pixels: new Uint8Array([9, UNPAINTED, 3]),
          emptyIndex: UNPAINTED,
        },
      ],
      draft: [],
    })

    expect(Array.from(artwork)).toEqual([9, 6, 3])
  })

  it('applies a template-owned colour selection to its render palette', () => {
    const scene = new RenderScene()
    const owned = template({
      appearance: { ...DEFAULT_APPEARANCE, hiddenColours: [5] },
      owns: ['colours'],
    })

    scene.advanceTemplates([owned], WORLD_TEMPLATE_SURFACE, 0, false)
    const [rendered] = scene.advanceTemplates([owned], WORLD_TEMPLATE_SURFACE, 300, false).templates
    if (rendered?.palette === null || rendered === undefined)
      throw new Error('render scene omitted a visible palette')

    expect(rendered.palette[5 * 4 + 3]).toBe(0)
    expect(rendered.palette[6 * 4 + 3]).toBe(255)
  })
})
