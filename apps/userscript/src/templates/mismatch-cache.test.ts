import {
  decodeMismatchMask,
  encodeMismatchMask,
  MATCH,
  type MismatchMask,
  TRANSPARENT_INDEX,
  WRONG,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'
import { markLocalX } from './mismatch-marks.js'
import { type ScanJob, type ScanOutcome, scanTile } from './mismatch-scan.js'

const harness = vi.hoisted(() => ({
  pixels: new Uint8Array(1_000 * 1_000).fill(1),
  draft: null as Uint8Array | null,
  templates: [] as PlacedTemplate[],
  serverMask: null as MismatchMask | null,
  workerAvailable: false,
  markersEnabled: true,
  visible: true,
  pixelsAvailable: true,
  workerScan: vi.fn<(...args: unknown[]) => Promise<ScanOutcome | null>>(),
  idleCallbacks: [] as Array<(deadline: { timeRemaining: () => number }) => void>,
  onTilePixelsAvailable: vi.fn(),
  onTilePixels: vi.fn(),
  onTilePixelsEvicted: vi.fn(),
}))

vi.mock('../debug.js', () => ({ count: vi.fn() }))
vi.mock('../tile-transform.js', () => ({
  draftPixels: () => harness.draft,
  ensureTilePixels: vi.fn(),
  draftedPixelOffsets: function* () {
    if (harness.draft?.[0] !== 255) yield 0
    if (harness.draft?.[1] !== 255) yield 1
  },
  loadTilePixels: async () => harness.pixels,
  onTilePixel: vi.fn(),
  onTilePixelsAvailable: harness.onTilePixelsAvailable,
  onTilePixels: harness.onTilePixels,
  onTilePixelsEvicted: harness.onTilePixelsEvicted,
  tilePixels: () => (harness.pixelsAvailable ? harness.pixels : null),
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
  isTemplateVisible: () => harness.visible,
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
  tiles: new Set(['0/0']),
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
  harness.draft = null
  harness.serverMask = null
  harness.workerAvailable = false
  harness.markersEnabled = true
  harness.visible = true
  harness.pixelsAvailable = true
  harness.workerScan.mockReset()
  harness.idleCallbacks = []
  vi.stubGlobal(
    'requestIdleCallback',
    (callback: (deadline: { timeRemaining: () => number }) => void) => {
      harness.idleCallbacks.push(callback)
    },
  )
  harness.onTilePixelsAvailable.mockReset()
  harness.onTilePixels.mockReset()
  harness.onTilePixelsEvicted.mockReset()
})

it.each(['pixels', 'mask'] as const)(
  'does not restore cancelled bulk drafts from a stale wrong-colour list after an outline-only %s scan',
  async (source) => {
    const one: PlacedTemplate = {
      ...template(0),
      width: 34,
      opaque: 34,
      indices: new Uint8Array(34),
      ...(source === 'mask' ? { serverUrl: 'https://templates.example' } : {}),
    }
    harness.templates = [one]
    harness.pixels.fill(0)
    harness.pixels[33] = 1
    if (source === 'mask') {
      const classes = new Uint8Array(34).fill(MATCH)
      classes[33] = WRONG
      harness.serverMask = decodeMismatchMask(
        encodeMismatchMask({ left: 0, top: 0, width: 34, height: 1 }, classes),
      )
    }
    const { pixelAccounting } = await import('./mismatch.js')
    const tile = { x: 0, y: 0 }
    const read = () => pixelAccounting.frame(() => pixelAccounting.read(one).tile(tile))
    expect(read()?.markers.length).toBe(1)
    const announce = harness.onTilePixels.mock.calls[0]?.[0]
    const triples = Array.from({ length: 33 }, (_, x) => [x, 0, 1]).flat()
    harness.draft = new Uint8Array(1_000_000).fill(255)
    harness.draft.fill(1, 0, 33)
    announce(tile, triples, 'draft')
    expect(read()?.markers.length).toBe(34)

    harness.draft = null
    announce(
      tile,
      triples.map((value, i) => (i % 3 === 2 ? 255 : value)),
      'draft',
    )
    harness.workerAvailable = true
    harness.workerScan.mockImplementation(async (job, indices) =>
      scanTile(job as ScanJob, indices as Uint8Array),
    )
    // The outline renderer asks first and only needs the unpainted projection.
    pixelAccounting.frame(() => pixelAccounting.read(one).unpainted(tile))
    await Promise.resolve()
    // A refresh must retain a complete drawable answer throughout; replacing it with a partial
    // entry makes the entire tile disappear while the missing projection is scanned.
    expect(read()?.markers.map(markLocalX)).toContain(33)
    await vi.waitFor(() => expect(read()?.markers.length).toBe(1))
    expect(read()?.markers.map(markLocalX)).toEqual(new Uint32Array([33]))
  },
)

afterEach(() => {
  vi.useRealTimers()
})

describe('visible mismatch answer retention', () => {
  it('requests pixel capture only for intersecting visible template tiles', async () => {
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(true)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(true)
    expect(wantsTilePixels({ x: 1, y: 0 })).toBe(false)
  })

  it('keeps pixel capture for local progress when every marker is disabled', async () => {
    harness.markersEnabled = false
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(true)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(true)
  })

  it('does not capture server template pixels when its markers are disabled', async () => {
    harness.markersEnabled = false
    harness.templates = [{ ...template(200), serverUrl: 'https://templates.example' }]
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(false)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(false)
  })

  it('uses server masks instead of capturing server template pixels when markers are enabled', async () => {
    harness.templates = [{ ...template(200), serverUrl: 'https://templates.example' }]
    const { wantsTilePixels } = await import('./mismatch.js')

    expect(wantsTilePixels()).toBe(false)
    expect(wantsTilePixels({ x: 0, y: 0 })).toBe(false)
  })

  it('keeps local progress current without retaining marker answers', async () => {
    harness.markersEnabled = false
    const selected = template(201)
    harness.templates = [selected]
    const { beginMismatchFrame, endMismatchFrame, progressFor, progressIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(progressIn(selected, { x: 0, y: 0 })).toBe(true)
    endMismatchFrame()
    expect(progressFor(selected)).toMatchObject({ completed: 0, mismatched: 1, known: 1 })

    harness.pixels[0] = 0
    const listener = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined
    listener?.({ x: 0, y: 0 }, [0, 0, 0])
    beginMismatchFrame()
    expect(progressIn(selected, { x: 0, y: 0 })).toBe(true)
    endMismatchFrame()
    expect(progressFor(selected)).toMatchObject({ completed: 1, mismatched: 0, known: 1 })
  })

  it('cold-loads every local template tile when a progress consumer asks after reload', async () => {
    const selected = template(209)
    harness.templates = [selected]
    harness.pixels[0] = 0
    harness.pixelsAvailable = false
    const { pixelAccounting } = await import('./mismatch.js')

    expect(pixelAccounting.read(selected).colours).toEqual([
      { index: 0, completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 1 },
    ])
    expect(harness.idleCallbacks).toHaveLength(1)

    harness.pixelsAvailable = true
    harness.idleCallbacks.shift()?.({ timeRemaining: () => 50 })

    expect(pixelAccounting.read(selected).colours).toEqual([
      { index: 0, completed: 1, mismatched: 0, unpainted: 0, known: 1, total: 1 },
    ])
  })

  it('cold-loads progress for a hidden local template without admitting unrelated tiles', async () => {
    const selected = template(210)
    harness.templates = [selected]
    harness.visible = false
    harness.pixels[0] = 0
    harness.pixelsAvailable = false
    const { pixelAccounting } = await import('./mismatch.js')

    expect(pixelAccounting.read(selected).progress).toMatchObject({ completed: 0, known: 0 })
    expect(pixelAccounting.wantsTilePixels()).toBe(true)
    expect(pixelAccounting.wantsTilePixels({ x: 0, y: 0 })).toBe(true)
    expect(pixelAccounting.wantsTilePixels({ x: 1, y: 0 })).toBe(false)

    harness.pixelsAvailable = true
    harness.idleCallbacks.shift()?.({ timeRemaining: () => 50 })

    expect(pixelAccounting.read(selected).progress).toMatchObject({ completed: 1, known: 1 })
  })

  it('exposes unpainted cells independently of the mismatch-marker threshold', async () => {
    const selected = template(203)
    harness.templates = [selected]
    harness.pixels[0] = 255
    const { beginMismatchFrame, endMismatchFrame, unpaintedIn } = await import('./mismatch.js')

    beginMismatchFrame()
    const marks = unpaintedIn(selected, { x: 0, y: 0 })
    endMismatchFrame()

    expect(marks).toHaveLength(1)
    expect(marks?.[0]).toBe(0)
  })

  it('does not mistake an outline-only answer for a complete mismatch list', async () => {
    const selected = template(204)
    harness.templates = [selected]
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn, unpaintedIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(unpaintedIn(selected, { x: 0, y: 0 })).toHaveLength(0)
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()
  })

  it('asks the worker for unpainted coordinates without allocating wrong-pixel markers', async () => {
    const selected = template(205)
    harness.templates = [selected]
    harness.workerAvailable = true
    harness.workerScan.mockResolvedValue(null)
    const { beginUnpaintedFrame, endUnpaintedFrame, unpaintedIn } = await import('./mismatch.js')

    beginUnpaintedFrame()
    expect(unpaintedIn(selected, { x: 0, y: 0 })).toBeNull()
    endUnpaintedFrame()

    expect(harness.workerScan).toHaveBeenCalledWith(
      expect.objectContaining({
        collectMarkers: true,
        collectWrong: false,
        collectUnpainted: true,
      }),
      selected.indices,
    )
  })

  it('lets an unpainted-only worker answer land before scheduling wrong-colour accounting', async () => {
    const selected = template(211)
    harness.templates = [selected]
    harness.pixels[0] = 255
    harness.workerAvailable = true
    let finishUnpainted: ((outcome: ScanOutcome) => void) | undefined
    let finishWrong: ((outcome: ScanOutcome) => void) | undefined
    const unpaintedOutcome: ScanOutcome = {
      wrong: new Uint32Array(0),
      unpainted: new Uint32Array([0]),
      asserted: 1,
      completed: 0,
      mismatched: 0,
      progressUnpainted: 1,
      progressAsserted: 1,
      progressByColour: new Uint32Array([0, 0, 0, 1]),
    }
    const wrongOutcome: ScanOutcome = {
      ...unpaintedOutcome,
      wrong: new Uint32Array(0),
      unpainted: new Uint32Array(0),
    }
    harness.workerScan
      .mockReturnValueOnce(
        new Promise<ScanOutcome>((resolve) => {
          finishUnpainted = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise<ScanOutcome>((resolve) => {
          finishWrong = resolve
        }),
      )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn, unpaintedIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(unpaintedIn(selected, { x: 0, y: 0 })).toBeNull()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toBeNull()
    endMismatchFrame()
    expect(harness.workerScan).toHaveBeenCalledOnce()
    expect(harness.workerScan.mock.calls[0]?.[0]).toMatchObject({
      collectWrong: false,
      collectUnpainted: true,
    })

    finishUnpainted?.(unpaintedOutcome)
    await vi.waitFor(() => {
      beginMismatchFrame()
      expect(unpaintedIn(selected, { x: 0, y: 0 })).toHaveLength(1)
      expect(mismatchesIn(selected, { x: 0, y: 0 })).toBeNull()
      endMismatchFrame()
      expect(harness.workerScan).toHaveBeenCalledTimes(2)
    })
    expect(harness.workerScan.mock.calls[1]?.[0]).toMatchObject({
      collectWrong: true,
      collectUnpainted: false,
    })

    finishWrong?.(wrongOutcome)
    await vi.waitFor(() => {
      beginMismatchFrame()
      expect(unpaintedIn(selected, { x: 0, y: 0 })).toHaveLength(1)
      expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(0)
      endMismatchFrame()
    })
  })

  it('resumes an unavailable outline scan when captured tile pixels arrive', async () => {
    const selected = template(206)
    harness.templates = [selected]
    harness.pixels[0] = 255
    harness.pixelsAvailable = false
    const { beginUnpaintedFrame, endUnpaintedFrame, unpaintedIn } = await import('./mismatch.js')

    beginUnpaintedFrame()
    expect(unpaintedIn(selected, { x: 0, y: 0 })).toBeNull()
    endUnpaintedFrame()

    harness.pixelsAvailable = true
    const available = harness.onTilePixelsAvailable.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }) => void)
      | undefined
    available?.({ x: 0, y: 0 })
    expect(harness.idleCallbacks).toHaveLength(1)
    harness.idleCallbacks.shift()?.({ timeRemaining: () => 50 })

    beginUnpaintedFrame()
    expect(unpaintedIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endUnpaintedFrame()
  })

  it('retries a rejected progress-only worker scan while idle', async () => {
    harness.markersEnabled = false
    harness.workerAvailable = true
    const selected = template(202)
    harness.templates = [selected]
    const outcome: ScanOutcome = {
      wrong: new Uint32Array(0),
      unpainted: new Uint32Array(0),
      asserted: 1,
      completed: 1,
      mismatched: 0,
      progressUnpainted: 0,
      progressAsserted: 1,
      progressByColour: new Uint32Array([0, 1, 0, 0]),
    }
    harness.workerScan.mockResolvedValueOnce(null).mockResolvedValueOnce(outcome)
    const { beginMismatchFrame, endMismatchFrame, progressFor, progressIn } = await import(
      './mismatch.js'
    )

    beginMismatchFrame()
    expect(progressIn(selected, { x: 0, y: 0 })).toBe(true)
    endMismatchFrame()
    await vi.waitFor(() => expect(harness.idleCallbacks).toHaveLength(1))

    harness.idleCallbacks.shift()?.({ timeRemaining: () => 10 })
    await vi.waitFor(() => expect(harness.workerScan).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(progressFor(selected)).toMatchObject({ completed: 1, mismatched: 0, known: 1 }),
    )
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

  it('retains recently offscreen answers for pan-back', async () => {
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
    expect(mismatchesIn(offscreenTemplate, { x: 0, y: 0 })).toBe(offscreen)
    endMismatchFrame()
  })

  it('evicts old offscreen answers without evicting a dense visible frame', async () => {
    harness.templates = Array.from({ length: 513 }, (_, index) => template(index))
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    const firstTemplate = harness.templates[0] as PlacedTemplate
    beginMismatchFrame()
    const first = mismatchesIn(firstTemplate, { x: 0, y: 0 })
    for (const candidate of harness.templates.slice(1)) mismatchesIn(candidate, { x: 0, y: 0 })
    endMismatchFrame()

    beginMismatchFrame()
    mismatchesIn(harness.templates[512] as PlacedTemplate, { x: 0, y: 0 })
    endMismatchFrame()

    beginMismatchFrame()
    expect(mismatchesIn(firstTemplate, { x: 0, y: 0 })).not.toBe(first)
    endMismatchFrame()
  })

  it('keeps complete markers while the server mask reloads without captured native pixels', async () => {
    const held = {
      ...template(200),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote',
      serverVersion: 'version',
    }
    harness.pixelsAvailable = false
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    const { pixelAccounting } = await import('./mismatch.js')
    const read = (current = held) =>
      pixelAccounting.frame(() => pixelAccounting.read(current).tile({ x: 0, y: 0 }))
    const answer = read()
    expect(answer?.markers).toHaveLength(1)
    harness.serverMask = null
    expect(read()?.markers).toBe(answer?.markers)
    expect(read({ ...held, moved: 1 })).toBeNull()
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([MATCH])),
    )
    expect(read()?.markers).toHaveLength(0)
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

  it('keeps merged wrong and unpainted marks in row-major order', async () => {
    const mixed = {
      ...template(201),
      width: 3,
      indices: new Uint8Array([0, 0, 0]),
      opaque: 3,
    }
    harness.pixels[0] = 1
    harness.pixels[1] = 255
    harness.pixels[2] = 1
    const { beginMismatchFrame, disagreementsIn, endMismatchFrame } = await import('./mismatch.js')

    beginMismatchFrame()
    const marks = disagreementsIn(mixed, { x: 0, y: 0 })
    endMismatchFrame()

    expect(marks && [...marks].map(markLocalX)).toEqual([0, 1, 2])
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
    const { pixelAccounting } = await import('./mismatch.js')
    expect(
      pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 })?.markers),
    ).toHaveLength(1)

    harness.workerAvailable = true
    harness.workerScan.mockReturnValueOnce(new Promise(() => undefined))
    const listener = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((
          tile: { x: number; y: number },
          triples: readonly number[],
          source: 'draft' | 'server',
        ) => void)
      | undefined
    listener?.({ x: 0, y: 0 }, Array.from({ length: 33 }, () => [0, 0, 1]).flat(), 'server')

    expect(
      pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 })?.markers),
    ).toHaveLength(1)
    expect(harness.workerScan).toHaveBeenCalledOnce()
  })

  it('drains stale scans without requestIdleCallback', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const selected = template(205)
    harness.templates = [selected]
    const { mismatchesIn } = await import('./mismatch.js')

    expect(mismatchesIn(selected, { x: 0, y: 0 })).toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    await vi.runAllTimersAsync()

    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
  })

  it('waits for unavailable tile pixels instead of spinning the timer fallback', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const selected = template(206)
    harness.templates = [selected]
    const { mismatchesIn } = await import('./mismatch.js')

    expect(mismatchesIn(selected, { x: 0, y: 0 })).toBeNull()
    harness.pixelsAvailable = false
    await vi.runOnlyPendingTimersAsync()
    expect(vi.getTimerCount()).toBe(0)

    harness.pixelsAvailable = true
    const listener = harness.onTilePixelsAvailable.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }) => void)
      | undefined
    listener?.({ x: 0, y: 0 })
    expect(vi.getTimerCount()).toBe(1)
    await vi.runAllTimersAsync()

    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
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
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn, pixelAccounting } = await import(
      './mismatch.js'
    )
    expect(
      pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 })?.markers),
    ).toHaveLength(1)

    harness.pixels.fill(0)
    harness.workerAvailable = true
    harness.workerScan.mockReturnValueOnce(new Promise(() => undefined))
    const listener = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((
          tile: { x: number; y: number },
          triples: readonly number[],
          source: 'draft' | 'server',
        ) => void)
      | undefined
    listener?.({ x: 0, y: 0 }, Array.from({ length: 33 }, () => [0, 0, 0]).flat(), 'server')

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

  it('keeps a server mismatch marked after a wrong draft is removed', async () => {
    const selected = {
      ...template(207),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.pixelsAvailable = false
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined

    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()

    harness.draft[0] = 2
    changed?.({ x: 0, y: 0 }, [0, 0, 2])
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()

    harness.draft[0] = 255
    changed?.({ x: 0, y: 0 }, [0, 0, 255])
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()
  })

  it('restores a server match after an erased draft pixel', async () => {
    const selected = {
      ...template(210),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.pixelsAvailable = false
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([MATCH])),
    )
    const { beginMismatchFrame, endMismatchFrame, mismatchesIn } = await import('./mismatch.js')
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined

    harness.draft[0] = TRANSPARENT_INDEX
    changed?.({ x: 0, y: 0 }, [0, 0, TRANSPARENT_INDEX])
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(1)
    endMismatchFrame()

    harness.draft[0] = 255
    changed?.({ x: 0, y: 0 }, [0, 0, 255])
    beginMismatchFrame()
    expect(mismatchesIn(selected, { x: 0, y: 0 })).toHaveLength(0)
    endMismatchFrame()
  })

  it('notifies draft subscribers before any local accounting record exists', async () => {
    harness.templates = [template(207)]
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    const { pixelAccounting } = await import('./mismatch.js')
    const draftChanged = vi.fn()
    pixelAccounting.onDraftChange(draftChanged)
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[], source: 'draft') => void)
      | undefined

    harness.draft[0] = 0
    changed?.({ x: 0, y: 0 }, [0, 0, 0], 'draft')

    expect(draftChanged).toHaveBeenCalledOnce()
  })

  it('removes a selected-colour disagreement as soon as the correct draft pixel is captured', async () => {
    const selected = {
      ...template(208),
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.pixelsAvailable = false
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    const { pixelAccounting } = await import('./mismatch.js')
    const draftChanged = vi.fn()
    pixelAccounting.onDraftChange(draftChanged)
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[], source: 'draft') => void)
      | undefined

    const initial = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(initial?.disagreements).toEqual(new Uint32Array([0]))
    expect(initial?.markers).toBe(initial?.mismatched)

    harness.draft[0] = 0
    changed?.({ x: 0, y: 0 }, [0, 0, 0], 'draft')
    expect(draftChanged).toHaveBeenCalledOnce()
    const fixed = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(fixed?.disagreements).toHaveLength(0)
    expect(pixelAccounting.read(selected).progress).toMatchObject({ completed: 1, known: 1 })
    expect(pixelAccounting.read(selected).colours).toEqual([
      { index: 0, completed: 1, mismatched: 0, unpainted: 0, known: 1, total: 1 },
    ])
    expect(pixelAccounting.read(selected).draftPixelDeltas).toEqual([
      {
        key: '0/0/0',
        basis: expect.any(String),
        index: 0,
        completed: 1,
        mismatched: -1,
        unpainted: 0,
      },
    ])

    harness.draft[0] = 2
    changed?.({ x: 0, y: 0 }, [0, 0, 2], 'draft')
    expect(pixelAccounting.read(selected).colours).toEqual([
      { index: 0, completed: 0, mismatched: 1, unpainted: 0, known: 1, total: 1 },
    ])
    expect(pixelAccounting.read(selected).draftPixelDeltas).toEqual([
      {
        key: '0/0/0',
        basis: expect.any(String),
        index: 0,
        completed: 0,
        mismatched: 0,
        unpainted: 0,
      },
    ])

    harness.draft[0] = 255
    changed?.({ x: 0, y: 0 }, [0, 0, 255], 'draft')
    expect(pixelAccounting.read(selected).colours).toEqual([
      { index: 0, completed: 0, mismatched: 1, unpainted: 0, known: 1, total: 1 },
    ])
    expect(pixelAccounting.read(selected).draftPixelDeltas).toEqual([])
    expect(draftChanged).toHaveBeenCalledTimes(3)
  })

  it('shares one revision basis across draft corrections in the same server tile', async () => {
    const selected = {
      ...template(210),
      width: 2,
      indices: new Uint8Array([0, 0]),
      opaque: 2,
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.draft[0] = 0
    harness.draft[1] = 0
    const { pixelAccounting } = await import('./mismatch.js')
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[], source: 'server') => void)
      | undefined

    const before = pixelAccounting.read(selected).draftPixelDeltas
    expect(before).toHaveLength(2)
    expect(before[0]).toMatchObject({ completed: 1, mismatched: -1 })
    expect(before[1]?.basis).toBe(before[0]?.basis)

    harness.pixels[0] = 0
    changed?.({ x: 0, y: 0 }, [0, 0, 0], 'server')
    const after = pixelAccounting.read(selected).draftPixelDeltas
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ key: '0/0/0', completed: 0, mismatched: 0 })
    expect(after[1]).toMatchObject({ key: '0/0/1', completed: 1, mismatched: -1 })
    expect(after[1]?.basis).toBe(after[0]?.basis)
    expect(after[0]?.basis).not.toBe(before[0]?.basis)
  })

  it('removes a disagreement when the matching draft lands on a non-symmetric row', async () => {
    const row = 123
    const selected = {
      ...template(209),
      originY: row,
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.pixelsAvailable = false
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: row, width: 1, height: 1 }, new Uint8Array([WRONG])),
    )
    const { pixelAccounting } = await import('./mismatch.js')
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((tile: { x: number; y: number }, triples: readonly number[]) => void)
      | undefined

    const initial = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(initial?.markers).toHaveLength(1)

    harness.draft[row * 1_000] = 0
    changed?.({ x: 0, y: 0 }, [0, row, 0])

    const fixed = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(fixed?.markers).toHaveLength(0)
    expect(pixelAccounting.read(selected).progress).toMatchObject({ completed: 1, known: 1 })
  })

  it('keeps the server mismatch mask authoritative while rescanning a large draft batch', async () => {
    const row = 123
    const width = 33
    const selected = {
      ...template(210),
      originY: row,
      width,
      indices: new Uint8Array(width),
      opaque: width,
      serverUrl: 'https://templates.example',
      serverTemplateId: 'remote-template',
      serverVersion: 'remote-version',
    }
    harness.templates = [selected]
    harness.pixelsAvailable = false
    harness.draft = new Uint8Array(1_000 * 1_000).fill(255)
    harness.serverMask = decodeMismatchMask(
      encodeMismatchMask(
        { left: 0, top: row, width, height: 1 },
        new Uint8Array(width).fill(WRONG),
      ),
    )
    const { pixelAccounting } = await import('./mismatch.js')
    const changed = harness.onTilePixels.mock.calls[0]?.[0] as
      | ((
          tile: { x: number; y: number },
          triples: readonly number[],
          source: 'draft' | 'server',
        ) => void)
      | undefined

    const initial = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(initial?.markers).toHaveLength(width)

    const triples: number[] = []
    for (let x = 0; x < width; x++) {
      harness.draft[row * 1_000 + x] = 0
      triples.push(x, row, 0)
    }
    changed?.({ x: 0, y: 0 }, triples, 'draft')

    const fixed = pixelAccounting.frame(() => pixelAccounting.read(selected).tile({ x: 0, y: 0 }))
    expect(fixed?.markers).toHaveLength(0)
    expect(pixelAccounting.read(selected).progress).toMatchObject({
      completed: width,
      known: width,
    })
  })
})
