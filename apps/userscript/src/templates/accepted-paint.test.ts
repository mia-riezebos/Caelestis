import {
  decodeMismatchMask,
  encodeMismatchMask,
  type MismatchMask,
  PALETTE_RGB,
  WRONG,
} from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from './local-store.js'

const harness = vi.hoisted(() => ({
  templates: [] as PlacedTemplate[],
  mask: null as MismatchMask | null,
  masks: new Map<string, MismatchMask>(),
  maskReads: vi.fn(),
}))
vi.mock('../debug.js', () => ({
  count: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  isEnabled: () => false,
}))
vi.mock('../server-mismatch.js', () => ({
  beginServerMismatchFrame: vi.fn(),
  endServerMismatchFrame: vi.fn(),
  onServerMismatchesChanged: vi.fn(),
  serverMismatchMaskFor: (template: PlacedTemplate) => {
    harness.maskReads(template.id)
    return harness.masks.get(template.id) ?? harness.mask
  },
}))
vi.mock('./colour-filter.js', () => ({ claimedHiddenFor: () => [] }))
vi.mock('./local-store.js', () => ({
  appearanceOf: () => ({ markMismatch: true, markSelectedColour: false, markUnpainted: true }),
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

beforeEach(() => {
  vi.resetModules()
  harness.masks.clear()
  harness.maskReads.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const setup = async () => {
  const selected: PlacedTemplate = {
    id: 'one',
    name: 'One',
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
    serverUrl: 'https://templates.example',
    serverTemplateId: 'one',
    serverVersion: 'v1',
  }
  harness.templates = [selected]
  harness.mask = decodeMismatchMask(
    encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
  )
  const pixels = await import('../tile-transform.js')
  const observations = await import('../pixel-observation.js')
  const { pixelAccounting } = await import('./mismatch.js')
  class FakeCanvas {
    getContext() {
      return null
    }
  }
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        let index = 0
        return {
          clearRect: () => {},
          drawImage: (bitmap: { index: number }) => {
            index = bitmap.index
          },
          getImageData: () => {
            const data = new Uint8ClampedArray(4_000_000)
            const rgb = PALETTE_RGB[index] ?? [0, 0, 0]
            const rgba = [...rgb, 255]
            for (let at = 0; at < data.length; at += 4) data.set(rgba, at)
            return { data }
          },
        }
      }
    },
  )
  const responses: Array<(response: Response) => void> = []
  const realm = {
    ...globalThis,
    Object,
    Request,
    URL,
    Response,
    Blob,
    ArrayBuffer,
    fetch: vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve)
        }),
    ),
    createImageBitmap: vi.fn(async (blob: Blob) => {
      const index = new Uint8Array(await blob.arrayBuffer())[0]
      const size = index === 255 ? 1 : 1000
      return { width: size, height: size, index, close: vi.fn() }
    }),
    HTMLCanvasElement: FakeCanvas,
  } as unknown as Window & typeof globalThis
  pixels.install(realm, () => null)
  const read = (template = selected) =>
    pixelAccounting.frame(() => pixelAccounting.read(template).tile({ x: 0, y: 0 }))
  const draft = (colour: number) => {
    const data = new Uint8Array(1_000_000).fill(pixels.UNPAINTED)
    data[0] = colour
    pixels.captureDraftPixels({ x: 0, y: 0 }, data)
  }
  const submit = (colour = 0, x = [0], y = [0], colours = [colour]) =>
    realm.fetch('https://backend.wplace.live/paint', {
      method: 'POST',
      body: JSON.stringify({
        season: 0,
        tiles: [{ x: 0, y: 0, pixels: { x, y, colors: colours } }],
      }),
    })
  const observed = vi.fn()
  pixels.onAcceptedPaint(observed)
  const accept = async (request = responses.length - 1, painted = 1, status = 200) => {
    const before = observed.mock.calls.length
    responses[request]?.(new Response(JSON.stringify({ painted }), { status }))
    if (status === 200) await vi.waitFor(() => expect(observed.mock.calls.length).toBe(before + 1))
  }
  const fetchTile = (colour = 255, tileX = 0) => {
    const pending = realm.fetch(`https://backend.wplace.live/files/s0/tiles/${tileX}/0.png`)
    const request = responses.length - 1
    return async () => {
      responses[request]?.(new Response(new Uint8Array([colour])))
      const response = await pending
      await realm.createImageBitmap(await response.blob())
    }
  }
  const accounting = () =>
    pixelAccounting.frame(() => {
      pixelAccounting.read(selected).tile({ x: 0, y: 0 })
      return {
        progress: pixelAccounting.read(selected).progress,
        deltas: pixelAccounting.read(selected).draftPixelDeltas,
      }
    })
  const replaceMask = (requested = observations.nextPixelObservation()) => {
    const mask = decodeMismatchMask(
      encodeMismatchMask({ left: 0, top: 0, width: 1, height: 1 }, new Uint8Array([WRONG])),
    ) as MismatchMask
    observations.recordPixelObservation(mask.packed, requested)
    harness.masks.set(selected.id, mask)
  }
  const respond = (request: number, response: Response) => responses[request]?.(response)
  return {
    pixels,
    read,
    draft,
    submit,
    accept,
    fetchTile,
    accounting,
    observations,
    replaceMask,
    respond,
    observed,
    selected,
  }
}

it('keeps a confirmed pixel matched after native cleanup while the tile refresh is delayed', async () => {
  const { pixels, read, draft, submit, accept } = await setup()
  expect(read()?.mismatched).toHaveLength(1)
  draft(0)
  expect(read()?.mismatched).toHaveLength(0)
  const accepted = vi.fn()
  pixels.onAcceptedPaint(accepted)
  const pending = submit()
  await accept()
  await pending
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
  pixels.clearDraftPixels()
  expect(read()?.mismatched).toHaveLength(0)
})

it('rejects an old tile observation and lets a later observation replace accepted paint', async () => {
  const { pixels, read, draft, submit, accept, fetchTile } = await setup()
  expect(read()?.mismatched).toHaveLength(1)
  const staleTile = fetchTile()
  draft(0)
  const pending = submit()
  await accept()
  await pending
  pixels.clearDraftPixels()
  await staleTile()
  expect(read()?.mismatched).toHaveLength(0)
  expect(read()?.unpainted).toHaveLength(0)

  // The fresh fixture is transparent: another painter has erased the accepted pixel.
  await fetchTile()()
  expect(read()?.unpainted).toHaveLength(1)
})

it('keeps accepted paint when a newer unrelated draft is cancelled', async () => {
  const { pixels, read, draft, submit, accept } = await setup()
  draft(0)
  const pending = submit()
  pixels.clearDraftPixels()
  draft(1)
  await accept()
  await pending
  expect(read()?.mismatched).toHaveLength(1)
  pixels.clearDraftPixels()
  expect(read()?.mismatched).toHaveLength(0)
  expect(pixels.draftPixels({ x: 0, y: 0 })).toBeNull()
})

it('does not let a late older submission replace a newer accepted colour', async () => {
  const { pixels, read, draft, submit, accept } = await setup()
  draft(1)
  const older = submit(1)
  draft(0)
  const newer = submit(0)
  await accept(1)
  await newer
  pixels.clearDraftPixels()
  await accept(0)
  await older
  expect(read()?.mismatched).toHaveLength(0)
})

it('counts accepted paint once and ignores older responses after a fresh matching tile', async () => {
  const { pixels, read, draft, submit, accept, fetchTile, accounting } = await setup()
  pixels.captureTilePixels(true)
  const staleTile = fetchTile(1)
  draft(0)
  const pending = submit()
  await accept()
  await pending
  pixels.clearDraftPixels()
  expect(accounting()).toMatchObject({ progress: { completed: 1 }, deltas: [] })
  await fetchTile(0)()
  expect(accounting()).toMatchObject({ progress: { completed: 1 }, deltas: [] })
  await staleTile()
  expect(read()?.mismatched).toHaveLength(0)
  await fetchTile(1)()
  expect(read()?.mismatched).toHaveLength(1)
  expect(accounting().progress.completed).toBe(0)
})

it('lets a fresh mask replace accepted paint for only its own template', async () => {
  const { pixels, read, draft, submit, accept, replaceMask, selected } = await setup()
  const other = { ...selected, id: 'other' }
  harness.templates.push(other)
  draft(0)
  const pending = submit()
  await accept()
  await pending
  pixels.clearDraftPixels()
  expect(read()?.mismatched).toHaveLength(0)
  replaceMask()
  expect(read()?.mismatched).toHaveLength(1)
  expect(read(other)?.mismatched).toHaveLength(0)
  draft(0)
  expect(read()?.mismatched).toHaveLength(0)
  pixels.clearDraftPixels()
  expect(read()?.mismatched).toHaveLength(1)
})

it('keeps accepted paint above a mask request started before acceptance', async () => {
  const { pixels, read, draft, submit, accept, replaceMask, observations } = await setup()
  const requested = observations.nextPixelObservation()
  draft(0)
  const pending = submit()
  await accept()
  await pending
  pixels.clearDraftPixels()
  replaceMask(requested)
  expect(read()?.mismatched).toHaveLength(0)
})

it.each([false, true])(
  'orders tile refresh against response arrival before delayed parsing (decode first: %s)',
  async (decodeFirst) => {
    const { pixels, read, draft, submit, fetchTile, respond, observed } = await setup()
    pixels.captureTilePixels(true)
    expect(read()?.mismatched).toHaveLength(1)
    draft(0)
    const pending = submit()
    const response = new Response(JSON.stringify({ painted: 1 }))
    const clone = response.clone()
    let finishBody: (body: { painted: number }) => void = () => {}
    vi.spyOn(clone, 'json').mockReturnValue(
      new Promise((resolve) => {
        finishBody = resolve
      }),
    )
    vi.spyOn(response, 'clone').mockReturnValue(clone)
    respond(0, response)
    await pending
    const fresh = fetchTile()
    if (decodeFirst) await fresh()
    finishBody({ painted: 1 })
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce())
    pixels.clearDraftPixels()
    if (!decodeFirst) await fresh()
    expect(read()?.unpainted).toHaveLength(1)
  },
)

it('stops forcing capture after paint retires and avoids fetching unrelated template masks', async () => {
  const { pixels, read, draft, submit, accept, fetchTile, selected } = await setup()
  harness.templates.push({ ...selected, id: 'unrelated', originX: 2000, tiles: new Set(['2/0']) })
  expect(read()?.mismatched).toHaveLength(1)
  draft(0)
  const pending = submit()
  await accept()
  await pending
  pixels.clearDraftPixels()
  await fetchTile(0)()
  expect(read()?.mismatched).toHaveLength(0)
  await fetchTile(1)()
  expect(pixels.tilePixels({ x: 0, y: 0 })?.[0]).toBe(0)
  expect(harness.maskReads).not.toHaveBeenCalledWith('unrelated')
})

it('preserves a newer submission fence across tile eviction while an older request remains pending', async () => {
  const { pixels, draft, submit, accept, fetchTile } = await setup()
  draft(1)
  const older = submit(1)
  draft(0)
  const newer = submit(0)
  await accept(1)
  await newer
  pixels.clearDraftPixels()
  await fetchTile(0)()
  pixels.captureTilePixels(true)
  for (let x = 1; x <= 65; x++) await fetchTile(255, x)()
  expect(pixels.tilePixels({ x: 0, y: 0 })).toBeNull()
  await accept(0)
  await older
  expect(pixels.comparisonDraftPixels({ x: 0, y: 0 })).toBeNull()
})

it.each([
  { painted: 0, status: 200, x: [0], y: [0], colours: [0] },
  { painted: 1, status: 429, x: [0], y: [0], colours: [0] },
  { painted: 1, status: 200, x: [0, 1], y: [0, 0], colours: [0, 0] },
  { painted: 1, status: 200, x: [0], y: [], colours: [0] },
])(
  'does not retain unconfirmed pixels from $status/$painted with $x',
  async ({ painted, status, x, y, colours }) => {
    const { pixels, read, draft, submit, accept } = await setup()
    draft(0)
    const pending = submit(0, x, y, colours)
    await accept(0, painted, status)
    await pending
    pixels.clearDraftPixels()
    expect(read()?.mismatched).toHaveLength(1)
  },
)
