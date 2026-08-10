import { WORLD_PIXELS } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedTemplate } from './import.js'
import type { PlacedTemplate, TileLevels } from './local-store.js'

const persistence = vi.hoisted(() => ({
  deleteTemplate: vi.fn(async () => true),
  loadTemplates: vi.fn(async (): Promise<unknown[]> => []),
  saveTemplate: vi.fn(async () => true),
}))

vi.mock('./persist.js', () => persistence)
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))

interface TestBitmap {
  readonly width: number
  readonly height: number
  readonly close: ReturnType<typeof vi.fn>
}

let deferredBitmap:
  | { readonly promise: Promise<TestBitmap>; readonly resolve: (bitmap: TestBitmap) => void }
  | undefined
const transferred: TestBitmap[] = []
const bitmapInputs: TestImageData[] = []
const createdBitmaps: TestBitmap[] = []
let canvasReadbacks = 0

const bitmap = (width: number, height: number): TestBitmap => ({ width, height, close: vi.fn() })

class TestImageData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

class TestCanvas {
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): object {
    return {
      beginPath: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => {
        canvasReadbacks++
        return { data: new Uint8ClampedArray(this.width * this.height * 4) }
      }),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      fillStyle: '',
    }
  }

  transferToImageBitmap(): TestBitmap {
    const result = bitmap(this.width, this.height)
    transferred.push(result)
    return result
  }
}

const template = (overrides: Partial<ImportedTemplate> = {}): ImportedTemplate => ({
  id: 'local-test',
  name: 'Test',
  source: 'image',
  originX: 10,
  originY: 20,
  width: 1,
  height: 1,
  indices: new Uint8Array([0]),
  moved: 0,
  opaque: 1,
  sortOrder: 0,
  ...overrides,
})

const deferOneBitmap = (): {
  readonly promise: Promise<TestBitmap>
  resolve: (value: TestBitmap) => void
} => {
  let resolve = (_value: TestBitmap): void => undefined
  const promise = new Promise<TestBitmap>((done) => {
    resolve = done
  })
  deferredBitmap = { promise, resolve }
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  transferred.length = 0
  bitmapInputs.length = 0
  createdBitmaps.length = 0
  canvasReadbacks = 0
  deferredBitmap = undefined
  vi.stubGlobal('window', {})
  vi.stubGlobal('ImageData', TestImageData)
  vi.stubGlobal('OffscreenCanvas', TestCanvas)
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (source: { width: number; height: number }) => {
      if (source instanceof TestImageData) bitmapInputs.push(source)
      if (deferredBitmap !== undefined) {
        const pending = deferredBitmap
        deferredBitmap = undefined
        return await pending.promise
      }
      const result = bitmap(source.width, source.height)
      createdBitmaps.push(result)
      return result
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local template lifecycle', () => {
  it('drops invalid legacy records while restoring the remaining templates', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'invalid', originX: -1 }),
        visible: true,
        everPlaced: true,
      },
      {
        ...template({ id: 'valid' }),
        visible: true,
        everPlaced: true,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['valid'])
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('invalid')
  })

  it('does not resolve an add until its IndexedDB write is durable', async () => {
    let finishSave = (_value: boolean): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishSave = resolve
        }),
    )
    const { addLocalTemplate } = await import('./local-store.js')
    let settled = false

    const added = addLocalTemplate(template()).then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledOnce())

    expect(settled).toBe(false)
    finishSave(true)
    await added
    expect(settled).toBe(true)
  })

  it('rejects placements that extend outside the native world', async () => {
    const { addLocalTemplate } = await import('./local-store.js')

    await expect(addLocalTemplate(template({ originX: -1 }))).rejects.toThrow(/outside/i)
    await expect(
      addLocalTemplate(
        template({ originX: WORLD_PIXELS - 1, width: 2, indices: new Uint8Array([0, 0]) }),
      ),
    ).rejects.toThrow(/east edge/i)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('keeps installed source levels alive until a replacement slice exists', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]
    const pending = deferOneBitmap()

    const moving = store.moveLocalTemplate(added.id, 30, 40)
    await Promise.resolve()

    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
    pending.resolve(bitmap(1_000, 1_000))
    await moving
    expect(oldLevels.every((level) => level.close.mock.calls.length === 1)).toBe(true)
  })

  it('keeps the old placement when a move cannot be saved', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]
    persistence.saveTemplate.mockResolvedValueOnce(false)

    await expect(store.moveLocalTemplate(added.id, 30, 40)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ originX: 10, originY: 20 })
    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
  })

  it('does not report unsaved delete, visibility, or appearance mutations in memory', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]

    persistence.saveTemplate.mockResolvedValueOnce(false)
    await expect(store.setLocalVisible(added.id, false)).resolves.toBe(false)
    expect(store.localTemplates()[0]?.visible).toBe(true)

    persistence.saveTemplate.mockResolvedValueOnce(false)
    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.25 }),
    ).resolves.toBe(false)
    expect(store.localTemplates()[0]?.appearance.opacity).toBe(1)

    persistence.deleteTemplate.mockResolvedValueOnce(false)
    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(false)
    expect(store.localTemplates()).toHaveLength(1)
    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
  })

  it('renders source pixels on both sides of a tile boundary', async () => {
    const store = await import('./local-store.js')

    await store.addLocalTemplate(
      template({
        originX: 999,
        originY: 0,
        width: 2,
        height: 1,
        indices: new Uint8Array([0, 1]),
        opaque: 2,
      }),
    )

    const fullTiles = bitmapInputs.filter(
      ({ width, height }) => width === 1_000 && height === 1_000,
    )
    expect(fullTiles).toHaveLength(2)
    expect(fullTiles[0]?.data[999 * 4 + 3]).toBe(255)
    expect(fullTiles[1]?.data[3]).toBe(255)
  })

  it('skips sparse empty tile rows without allocating rendered buffers for them', async () => {
    const store = await import('./local-store.js')
    const height = 2_047_001
    const indices = new Uint8Array(height).fill(255)
    indices[0] = 0
    indices[height - 1] = 0

    const added = await store.addLocalTemplate(
      template({ originX: 0, originY: 0, width: 1, height, indices, opaque: 2 }),
    )

    expect([...added.tiles.keys()]).toEqual(['0/0', '0/2047'])
  })

  it('coalesces overlapping moves so the latest requested origin wins', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template())
    const pending = deferOneBitmap()

    const first = store.moveLocalTemplate('local-test', 100, 200)
    await Promise.resolve()
    const second = store.moveLocalTemplate('local-test', 300, 400)
    pending.resolve(bitmap(1_000, 1_000))
    await Promise.all([first, second])

    expect(store.localTemplates()[0]).toMatchObject({ originX: 300, originY: 400 })
  })

  it('renders imported source order from lowest to highest', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template({ id: 'high', sortOrder: 10 }))
    await store.addLocalTemplate(template({ id: 'low', sortOrder: 0 }))

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['low', 'high'])
  })

  it('selects the smallest mip that is not smaller than the target', async () => {
    const store = await import('./local-store.js')
    const levels = {
      levels: [bitmap(1_000, 1_000), bitmap(500, 500), bitmap(250, 250)],
    } as unknown as TileLevels

    expect(store.levelFor(levels, 600).width).toBe(1_000)
    expect(store.levelFor(levels, 500).width).toBe(500)
    expect(store.levelFor(levels, 200).width).toBe(250)
  })

  it('builds shaped stamps outside the synchronous frame path and gives them usable mips', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const source = added.tiles.get('0/0')
    if (source === undefined) throw new Error('expected source tile')
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [],
    } as const

    expect(store.stampTile(added, '0/0', appearance, 1_000)).toBe(source)
    expect(canvasReadbacks).toBe(0)
    expect(transferred).toHaveLength(0)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 1_000)).not.toBe(source),
    )
    const stamp = store.stampTile(added, '0/0', appearance, 1_000)
    expect(stamp?.levels.map((level) => level.width)).toEqual([3_000, 1_500, 750, 375, 187, 93])

    await store.moveLocalTemplate(added.id, 30, 40)

    expect(
      stamp?.levels.every((level) => (level as TestBitmap).close.mock.calls.length === 1),
    ).toBe(true)
  })

  it('uses a native-scale filtered stamp when shaped pixels are too small to read', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const source = added.tiles.get('0/0')
    if (source === undefined) throw new Error('expected source tile')
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [1],
    } as const

    store.stampTile(added, '0/0', appearance, 500)
    await vi.waitFor(() => {
      const current = store.stampTile(added, '0/0', appearance, 500)
      expect(current).toBeDefined()
      expect(current).not.toBe(source)
    })
    const stamp = store.stampTile(added, '0/0', appearance, 500)

    expect(stamp?.levels.map((level) => level.width)).toEqual([1_000, 500, 250, 125])
  })

  it('evicts least-recently-used stamped tiles instead of retaining an unbounded cache', async () => {
    const store = await import('./local-store.js')
    const sourceTiles = new Map<string, TileLevels>()
    for (let tileX = 0; tileX < 13; tileX++) {
      sourceTiles.set(`${tileX}/0`, {
        levels: [bitmap(1_000, 1_000) as unknown as ImageBitmap],
      })
    }
    const placed = {
      ...template({
        width: 13_000,
        height: 1,
        indices: new Uint8Array(13_000),
        opaque: 13_000,
      }),
      tiles: sourceTiles,
      visible: true,
      everPlaced: true,
      appearance: { shape: 'full', size: 1, anchor: 'c', opacity: 1, hiddenColours: [1] },
    } as unknown as PlacedTemplate

    for (let tileX = 0; tileX < 13; tileX++) {
      store.stampTile(placed, `${tileX}/0`, placed.appearance)
    }
    await vi.waitFor(() => expect(store.stampTile(placed, '12/0', placed.appearance)).toBeDefined())

    expect(createdBitmaps.slice(0, 4).every(({ close }) => close.mock.calls.length === 1)).toBe(
      true,
    )
    expect(store.stampTile(placed, '0/0', placed.appearance)).toBeUndefined()
  })
})
