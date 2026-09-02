import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import type { NativePixelSnapshot } from '../native-pixels.js'
import { DEFAULT_APPEARANCE } from '../templates/appearance.js'
import { markLocalX, markLocalY, markWanted } from '../templates/mismatch-marks.js'
import {
  artboardColourProgress,
  artboardColourTargets,
  artboardMarkerWork,
  artboardRemainingColours,
  artboardTemplateProgress,
} from './artboard-markers.js'

const template = {
  id: 'alliance-template',
  name: 'alliance.png',
  visible: true,
  originX: -1,
  originY: -1,
  width: 2,
  height: 2,
  indices: new Uint8Array([4, 7, 7, TRANSPARENT_INDEX]),
  surface: { kind: 'alliance-headquarters', allianceId: 535_245 } as const,
}

const points = (batch: { x: number; y: number; marks: Uint32Array }) =>
  [...batch.marks].map((mark) => [
    batch.x + markLocalX(mark),
    batch.y + markLocalY(mark),
    markWanted(mark),
  ])

const committed = (
  regions: readonly Omit<NativePixelSnapshot['committed'][number], 'emptyIndex'>[],
): NativePixelSnapshot => ({
  committed: regions.map((region) => ({ ...region, emptyIndex: TRANSPARENT_INDEX })),
  draft: [],
})

describe('alliance artboard marker work', () => {
  it('reports the palette colours that still differ from native art', () => {
    const remaining = artboardRemainingColours(
      template,
      committed([{ x: -1, y: -1, width: 2, height: 2, pixels: new Uint8Array([4, 3, 7, 1]) }]),
    )

    expect([...remaining]).toEqual([7])
  })

  it('reports overall alliance progress from native art', () => {
    expect(
      artboardTemplateProgress(
        template,
        committed([
          {
            x: -1,
            y: -1,
            width: 2,
            height: 2,
            pixels: new Uint8Array([4, 3, TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
          },
        ]),
      ),
    ).toEqual({ completed: 1, mismatched: 1, unpainted: 1, known: 3, total: 3 })
  })

  it('keeps unloaded HQ pixels unknown instead of marking them unpainted', () => {
    const regions = committed([{ x: -1, y: -1, width: 1, height: 1, pixels: new Uint8Array([4]) }])

    expect(artboardColourProgress(template, regions)).toEqual([
      { index: 4, completed: 1, mismatched: 0, unpainted: 0, known: 1, total: 1 },
      { index: 7, completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 2 },
    ])
    expect(
      artboardMarkerWork(template, regions, { ...DEFAULT_APPEARANCE, markSelectedColour: true })
        .selected,
    ).toEqual([])
  })

  it('ignores loaded HQ tiles outside the template bounds', () => {
    const regions = committed([
      { x: -65, y: -64, width: 64, height: 64, pixels: new Uint8Array(64 * 64) },
      { x: 64, y: 64, width: 64, height: 64, pixels: new Uint8Array(64 * 64) },
    ])

    expect(artboardTemplateProgress(template, regions)).toEqual({
      completed: 0,
      mismatched: 0,
      unpainted: 0,
      known: 0,
      total: 3,
    })
    expect(artboardMarkerWork(template, regions, DEFAULT_APPEARANCE)).toEqual({
      mismatch: [],
      selected: [],
    })
  })

  it('measures the unpainted marker threshold from loaded pixels only', () => {
    const work = artboardMarkerWork(
      template,
      committed([
        {
          x: -1,
          y: -1,
          width: 2,
          height: 1,
          pixels: new Uint8Array([4, TRANSPARENT_INDEX]),
        },
      ]),
      {
        ...DEFAULT_APPEARANCE,
        markMismatch: true,
        markUnpainted: true,
        unpaintedLimit: 0.4,
      },
    )

    expect(work.mismatch).toEqual([])
  })

  it('finds known mismatched and unpainted targets for alliance colour navigation', () => {
    expect(
      artboardColourTargets(
        template,
        committed([
          {
            x: -1,
            y: -1,
            width: 2,
            height: 2,
            pixels: new Uint8Array([4, TRANSPARENT_INDEX, 2, TRANSPARENT_INDEX]),
          },
        ]),
        7,
      ),
    ).toEqual([
      { x: 0, y: -1, kind: 'unpainted' },
      { x: -1, y: 0, kind: 'mismatched' },
    ])
  })

  it('builds mismatch markers from the native art pixels', () => {
    const work = artboardMarkerWork(
      template,
      committed([{ x: -1, y: -1, width: 2, height: 2, pixels: new Uint8Array([4, 3, 2, 1]) }]),
      { ...DEFAULT_APPEARANCE, markMismatch: true },
    )

    expect(work.mismatch.flatMap(points)).toEqual([
      [0, -1, 7],
      [-1, 0, 7],
    ])
  })

  it('builds selected-colour markers only for unpainted pixels of that colour', () => {
    const work = artboardMarkerWork(
      template,
      committed([
        {
          x: -1,
          y: -1,
          width: 2,
          height: 2,
          pixels: new Uint8Array([4, TRANSPARENT_INDEX, TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
        },
      ]),
      { ...DEFAULT_APPEARANCE, markSelectedColour: true },
    )

    expect(work.selected).toHaveLength(1)
    expect(work.selected[0]?.index).toBe(7)
    expect(work.selected[0]?.batches.flatMap(points)).toEqual([
      [0, -1, 7],
      [-1, 0, 7],
    ])
  })

  it('retains marker data while its visibility toggle is off', () => {
    const work = artboardMarkerWork(
      template,
      committed([
        {
          x: -1,
          y: -1,
          width: 2,
          height: 2,
          pixels: new Uint8Array([4, 3, TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
        },
      ]),
      { ...DEFAULT_APPEARANCE, markMismatch: false, markSelectedColour: false },
    )

    expect(work.mismatch.flatMap(points)).toEqual([[0, -1, 7]])
    expect(work.selected[0]?.batches.flatMap(points)).toEqual([[-1, 0, 7]])
  })

  it('uses native draft pixels for progress, markers, and navigation', () => {
    const pixels: NativePixelSnapshot = {
      committed: [
        {
          x: -1,
          y: -1,
          width: 2,
          height: 2,
          pixels: new Uint8Array([4, 3, TRANSPARENT_INDEX, TRANSPARENT_INDEX]),
          emptyIndex: TRANSPARENT_INDEX,
        },
      ],
      draft: [
        {
          x: -1,
          y: -1,
          width: 2,
          height: 2,
          pixels: new Uint8Array([255, 7, 7, 255]),
          emptyIndex: 255,
        },
      ],
    }

    expect(artboardTemplateProgress(template, pixels)).toEqual({
      completed: 3,
      mismatched: 0,
      unpainted: 0,
      known: 3,
      total: 3,
    })
    expect(artboardMarkerWork(template, pixels, DEFAULT_APPEARANCE)).toEqual({
      mismatch: [],
      selected: [],
    })
    expect(artboardColourTargets(template, pixels, 7)).toEqual([])
  })
})
