import { decodePng, WORLD_PIXELS, WPLACE_PALETTE } from '@wts/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedTemplate } from './import.js'
import type { PlacedTemplate, TileLevels } from './local-store.js'

const persistence = vi.hoisted(() => ({
  deleteTemplate: vi.fn(
    async (): Promise<
      { status: 'saved'; revision: number } | { status: 'conflict' } | { status: 'unavailable' }
    > => ({ status: 'saved', revision: 1 }),
  ),
  loadTemplate: vi.fn(
    async (): Promise<
      { status: 'loaded'; template: unknown } | { status: 'missing' } | { status: 'unavailable' }
    > => ({ status: 'missing' }),
  ),
  loadTemplates: vi.fn(
    async (
      _maxTemplates?: number,
      _maxIndexPixels?: number,
      _excludedIds?: ReadonlySet<string>,
    ): Promise<unknown[]> => [],
  ),
  saveTemplate: vi.fn(
    async (
      _template: unknown,
      expectedRevision: number | null,
    ): Promise<
      { status: 'saved'; revision: number } | { status: 'conflict' } | { status: 'unavailable' }
    > => ({ status: 'saved', revision: (expectedRevision ?? 0) + 1 }),
  ),
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
const contextOptions: unknown[] = []
let canvasReadbacks = 0
let missingContextWidth: number | undefined

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

  getContext(_kind?: string, options?: unknown): object | null {
    contextOptions.push(options)
    if (this.width === missingContextWidth) return null
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
      putImageData: vi.fn(),
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

  async convertToBlob(): Promise<Blob> {
    return new Blob(['png'], { type: 'image/png' })
  }
}

const template = (overrides: Partial<ImportedTemplate> = {}): ImportedTemplate => ({
  id: 'local-test',
  name: 'Test',
  source: 'wplace',
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
  contextOptions.length = 0
  canvasReadbacks = 0
  missingContextWidth = undefined
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
  vi.useRealTimers()
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
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('invalid', 0)
  })

  it('deletes a record whose CAS revision can no longer be incremented', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'exhausted' }),
        visible: true,
        everPlaced: true,
        revision: Number.MAX_SAFE_INTEGER,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toEqual([])
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('exhausted', Number.MAX_SAFE_INTEGER)
  })

  it('restores a valid persisted record hidden when rendering fails transiently', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template({ id: 'valid' }), visible: true, everPlaced: true },
    ])
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('GPU allocation failed'))
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toEqual([
      expect.objectContaining({ id: 'valid', visible: false, tiles: new Map() }),
    ])
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
  })

  it('preserves persisted appearance while restoring', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'styled' }),
        visible: false,
        everPlaced: true,
        appearance: {
          shape: 'circle',
          size: 1 / 3,
          anchor: 'c',
          opacity: 0.25,
          hiddenColours: [1],
        },
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()[0]?.appearance).toMatchObject({
      shape: 'circle',
      opacity: 0.25,
      hiddenColours: [1],
    })
  })

  it('normalises malformed persisted appearance without poisoning rendering', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'styled', source: 'marble' }),
        visible: false,
        everPlaced: true,
        appearance: { shape: 'circle', hiddenColours: null },
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()[0]?.appearance).toMatchObject({
      shape: 'full',
      hiddenColours: [],
    })
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
  })

  it('bounds template text and duplicate-heavy persisted colour metadata', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'styled', source: 'marble' }),
        visible: false,
        everPlaced: true,
        appearance: {
          shape: 'circle',
          size: 1 / 3,
          anchor: 'c',
          opacity: 1,
          hiddenColours: Array.from({ length: 65 }, () => 1),
        },
      },
    ])
    const store = await import('./local-store.js')

    await expect(store.addLocalTemplate(template({ id: 'x'.repeat(129) }))).rejects.toThrow(
      /metadata/i,
    )
    await expect(store.addLocalTemplate(template({ name: 'x'.repeat(257) }))).rejects.toThrow(
      /metadata/i,
    )
    await store.restoreLocalTemplates()

    expect(store.localTemplates()[0]?.appearance).toMatchObject({
      hiddenColours: [],
      shape: 'full',
    })
  })

  it('discards irreparable persisted runtime shapes independently', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template({ id: 'bad', source: 'unknown' as never }), visible: true, everPlaced: true },
      {
        ...template({ id: 'boxed' }),
        source: new String('image'),
        visible: true,
        everPlaced: true,
      },
      { ...template({ id: 'good', source: 'marble' }), visible: false, everPlaced: true },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['good'])
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('bad', 0)
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('boxed', 0)
  })

  it('discards persisted palette bytes and opaque counts that cannot render faithfully', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'bad-index', indices: new Uint8Array([64]) }),
        visible: false,
        everPlaced: true,
      },
      {
        ...template({ id: 'bad-count', opaque: 1, indices: new Uint8Array([255]) }),
        visible: false,
        everPlaced: true,
      },
      {
        ...template({ id: 'good', source: 'marble' }),
        visible: false,
        everPlaced: true,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['good'])
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('bad-index', 0)
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('bad-count', 0)
  })

  it('retries later persisted candidates after deleting an invalid admission', async () => {
    persistence.loadTemplates
      .mockResolvedValueOnce([
        {
          ...template({ id: 'invalid', indices: new Uint8Array([64]) }),
          visible: false,
          everPlaced: true,
        },
      ])
      .mockResolvedValueOnce([
        { ...template({ id: 'valid', source: 'marble' }), visible: false, everPlaced: true },
      ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['valid'])
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(2)
    expect(persistence.loadTemplates.mock.calls[1]?.[2]).toEqual(new Set(['invalid', 'valid']))
  })

  it('retries past a transient hydration failure without deleting its durable record', async () => {
    persistence.loadTemplates
      .mockResolvedValueOnce([
        {
          kind: 'template-hydration-failure',
          status: 'unavailable',
          id: 'unavailable',
          revision: 2,
        },
      ])
      .mockResolvedValueOnce([
        { ...template({ id: 'valid', source: 'marble' }), visible: false, everPlaced: true },
      ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['valid'])
    expect(persistence.deleteTemplate).not.toHaveBeenCalledWith('unavailable', 2)
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(2)
    expect(persistence.loadTemplates.mock.calls[1]?.[2]).toEqual(new Set(['unavailable', 'valid']))
  })

  it('deletes a permanently invalid hydrated Blob before retrying later records', async () => {
    persistence.loadTemplates
      .mockResolvedValueOnce([
        {
          kind: 'template-hydration-failure',
          status: 'invalid',
          id: 'invalid-blob',
          revision: 3,
        },
      ])
      .mockResolvedValueOnce([])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(persistence.deleteTemplate).toHaveBeenCalledWith('invalid-blob', 3)
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent restores and clears the slot after rejection', async () => {
    let finishLoad = (_templates: unknown[]): void => undefined
    persistence.loadTemplates.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          finishLoad = resolve
        }),
    )
    const store = await import('./local-store.js')

    const first = store.restoreLocalTemplates()
    const concurrent = store.restoreLocalTemplates()
    expect(concurrent).toBe(first)
    finishLoad([])
    await first

    persistence.loadTemplates.mockRejectedValueOnce(new Error('read failed'))
    await expect(store.restoreLocalTemplates()).rejects.toThrow('read failed')
    persistence.loadTemplates.mockResolvedValueOnce([])
    await expect(store.restoreLocalTemplates()).resolves.toBeUndefined()
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(3)
  })

  it('bounds repeated restore retries even if persistence ignores excluded ids', async () => {
    persistence.loadTemplates.mockResolvedValue([
      {
        ...template({ id: 'invalid', indices: new Uint8Array([64]) }),
        visible: false,
        everPlaced: true,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(persistence.loadTemplates).toHaveBeenCalledTimes(64)
  })

  it('serializes imports behind startup restore so failed adds cannot suppress durable state', async () => {
    let finishLoad = (_templates: unknown[]): void => undefined
    persistence.loadTemplates.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          finishLoad = resolve
        }),
    )
    const store = await import('./local-store.js')

    const restoring = store.restoreLocalTemplates()
    const adding = store.addLocalTemplate(template())
    const rejected = expect(adding).rejects.toThrow(/already exists/i)
    finishLoad([{ ...template(), visible: false, everPlaced: true }])

    await restoring
    await rejected
    expect(store.localTemplates().map(({ id }) => id)).toEqual(['local-test'])
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
  })

  it('reserves a restoring id before bitmap work yields to a concurrent import', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template(), visible: true, everPlaced: true },
    ])
    const pending = deferOneBitmap()
    const store = await import('./local-store.js')

    const restoring = store.restoreLocalTemplates()
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce())
    const adding = store.addLocalTemplate(template())
    pending.resolve(bitmap(1_000, 1_000))
    await restoring
    await expect(adding).rejects.toThrow(/already exists/i)
    expect(store.localTemplates()).toHaveLength(1)
  })

  it('bounds restored template cardinality even if persistence returns extra records', async () => {
    persistence.loadTemplates.mockResolvedValueOnce(
      Array.from({ length: 65 }, (_, id) => ({
        ...template({ id: `stored-${id}`, source: 'marble' }),
        visible: false,
        everPlaced: true,
      })),
    )
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toHaveLength(64)
  })

  it('does not resolve an add until its IndexedDB write is durable', async () => {
    let finishSave = (_value: { status: 'saved'; revision: number }): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<{ status: 'saved'; revision: number }>((resolve) => {
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
    finishSave({ status: 'saved', revision: 1 })
    await added
    expect(settled).toBe(true)
  })

  it('isolates page-global and listener failures after a durable mutation', async () => {
    Object.defineProperty(window, '__wtsLocal', { value: [], writable: false, configurable: true })
    const store = await import('./local-store.js')
    store.onLocalChange(() => {
      throw new Error('observer failed')
    })

    await expect(store.addLocalTemplate(template())).resolves.toMatchObject({ id: 'local-test' })

    expect(store.localTemplates()).toHaveLength(1)
    expect(persistence.saveTemplate).toHaveBeenCalledOnce()
  })

  it('mirrors diagnostics onto the page realm rather than the userscript sandbox', async () => {
    const pageRealm: Record<string, unknown> = {}
    vi.stubGlobal('unsafeWindow', pageRealm)
    const store = await import('./local-store.js')

    await store.addLocalTemplate(template())

    expect(pageRealm.__wtsLocal).toEqual([
      expect.objectContaining({ id: 'local-test', originX: 10, originY: 20 }),
    ])
    expect((window as unknown as Record<string, unknown>).__wtsLocal).toBeUndefined()
  })

  it('persists final origin and first-placement state atomically', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template({ source: 'image' }))

    expect(persistence.saveTemplate).not.toHaveBeenCalled()

    await expect(store.placeLocalTemplate('local-test', 30, 40)).resolves.toBe(true)

    expect(persistence.saveTemplate).toHaveBeenCalledOnce()
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ originX: 30, originY: 40, everPlaced: true }),
      null,
    )
    expect(store.localTemplates()[0]?.revision).toBe(1)
  })

  it('discards a pending image locally without touching IndexedDB', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template({ source: 'image' }))

    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(true)

    expect(store.localTemplates()).toEqual([])
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
  })

  it('yields while scanning a large sparse source tile', async () => {
    const browserYield = vi.fn(async () => undefined)
    vi.stubGlobal('scheduler', { yield: browserYield })
    const indices = new Uint8Array(1_000_000).fill(63)
    indices[indices.length - 1] = 0
    const store = await import('./local-store.js')

    await store.addLocalTemplate(template({ width: 1_000, height: 1_000, indices, opaque: 1 }))

    expect(browserYield.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps drag previews transient without reslicing or writing', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    vi.clearAllMocks()

    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)

    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
    expect(store.localTemplates()[0]?.originX).toBe(10)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
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

  it('keeps installed stamps alive until a moved replacement is installed', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    await store.setAppearance(added.id, { ...added.appearance, hiddenColours: [0] })
    const styled = store.localTemplates()[0]
    if (styled === undefined) throw new Error('expected template')
    store.stampTile(styled, '0/0', styled.appearance, 1_000)
    await vi.waitFor(() =>
      expect(store.stampTile(styled, '0/0', styled.appearance, 1_000)).toBeDefined(),
    )
    const stamp = store.stampTile(styled, '0/0', styled.appearance, 1_000)
    const pending = deferOneBitmap()
    const buildsBeforeMove = vi.mocked(createImageBitmap).mock.calls.length

    expect(store.previewLocalTemplate(styled.id, 30, 40)).toBe(true)
    const moving = store.placeLocalTemplate(styled.id, 30, 40)
    await vi.waitFor(() =>
      expect(vi.mocked(createImageBitmap).mock.calls.length).toBeGreaterThan(buildsBeforeMove),
    )

    const current = store.localTemplates()[0]
    if (current === undefined) throw new Error('expected template')
    expect(store.previewOriginFor(styled.id)).toEqual({ x: 30, y: 40 })
    expect(store.stampTile(current, '0/0', current.appearance, 1_000)).toBe(stamp)
    expect(stamp?.levels.every((level) => !(level as TestBitmap).close.mock.calls.length)).toBe(
      true,
    )

    pending.resolve(bitmap(1_000, 1_000))
    await expect(moving).resolves.toBe(true)
    expect(
      stamp?.levels.every((level) => (level as TestBitmap).close.mock.calls.length === 1),
    ).toBe(true)
  })

  it('keeps the old placement when a move cannot be saved', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    await expect(store.moveLocalTemplate(added.id, 30, 40)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ originX: 10, originY: 20 })
    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
  })

  it('does not report unsaved delete, visibility, or appearance mutations in memory', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]

    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    await expect(store.setLocalVisible(added.id, false)).resolves.toBe(false)
    expect(store.localTemplates()[0]?.visible).toBe(true)

    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.25 }),
    ).resolves.toBe(false)
    expect(store.localTemplates()[0]?.appearance.opacity).toBe(1)

    persistence.deleteTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)
    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(false)
    expect(store.localTemplates()).toHaveLength(1)
    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
  })

  it('releases source levels while hidden and rebuilds them only when shown', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]

    await expect(store.setLocalVisible(added.id, false)).resolves.toBe(true)

    expect(store.localTemplates()[0]?.tiles.size).toBe(0)
    expect(oldLevels.every((level) => level.close.mock.calls.length === 1)).toBe(true)
    const buildsBeforeShow = vi.mocked(createImageBitmap).mock.calls.length

    await expect(store.setLocalVisible(added.id, true)).resolves.toBe(true)

    expect(store.localTemplates()[0]?.tiles.size).toBe(1)
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBeGreaterThan(buildsBeforeShow)
  })

  it('bounds retained source mip chains across multiple dense templates', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(
      template({
        id: 'first',
        originX: 0,
        originY: 0,
        width: 12_000,
        height: 1,
        indices: new Uint8Array(12_000),
        opaque: 12_000,
      }),
    )
    await store.addLocalTemplate(
      template({
        id: 'second',
        originX: 0,
        originY: 2,
        width: 12_000,
        height: 1,
        indices: new Uint8Array(12_000),
        opaque: 12_000,
      }),
    )

    await expect(store.moveLocalTemplate('first', 1_000, 0)).resolves.toBe(true)

    await expect(
      store.addLocalTemplate(
        template({
          id: 'third',
          originX: 0,
          originY: 4,
          width: 1,
          height: 1,
          indices: new Uint8Array([0]),
          opaque: 1,
        }),
      ),
    ).rejects.toThrow(/source bitmap budget/i)
    expect(store.localTemplates().map(({ id }) => id)).toEqual(['first', 'second'])
  })

  it('admits restored templates hidden after the source bitmap budget is exhausted', async () => {
    const indices = new Uint8Array(12_000)
    persistence.loadTemplates.mockResolvedValueOnce(
      ['first', 'second', 'third'].map((id, row) => ({
        ...template({
          id,
          originX: 0,
          originY: row * 2,
          width: indices.length,
          indices,
          opaque: indices.length,
        }),
        visible: true,
        everPlaced: true,
      })),
    )
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(
      store.localTemplates().map(({ id, visible, tiles }) => ({ id, visible, tiles: tiles.size })),
    ).toEqual([
      { id: 'first', visible: true, tiles: 12 },
      { id: 'second', visible: true, tiles: 12 },
      { id: 'third', visible: false, tiles: 0 },
    ])
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
  })

  it('returns false when showing a hidden template cannot build source bitmaps', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    await store.setLocalVisible(added.id, false)
    persistence.saveTemplate.mockClear()
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('GPU allocation failed'))

    await expect(store.setLocalVisible(added.id, true)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ visible: false })
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
    await expect(store.setLocalVisible(added.id, true)).resolves.toBe(true)
  })

  it('bounds overlapping source builds before concurrent imports can commit', async () => {
    const store = await import('./local-store.js')
    const results = await Promise.allSettled(
      ['first', 'second', 'third'].map((id, row) =>
        store.addLocalTemplate(
          template({
            id,
            originX: 0,
            originY: row * 2,
            width: 12_000,
            height: 1,
            indices: new Uint8Array(12_000),
            opaque: 12_000,
          }),
        ),
      ),
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(store.localTemplates()).toHaveLength(2)
  })

  it('rejects one template before it can retain more than twelve source tiles', async () => {
    const store = await import('./local-store.js')

    await expect(
      store.addLocalTemplate(
        template({
          width: 13_000,
          height: 1,
          indices: new Uint8Array(13_000),
          opaque: 13_000,
        }),
      ),
    ).rejects.toThrow(/too many painted tiles/i)
    expect(store.localTemplates()).toEqual([])
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

  it('lets a return to the installed origin supersede an in-flight move', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferOneBitmap()

    const away = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const back = store.moveLocalTemplate(added.id, added.originX, added.originY)
    pending.resolve(bitmap(1_000, 1_000))

    await expect(Promise.all([away, back])).resolves.toEqual([true, true])
    expect(store.localTemplates()[0]).toMatchObject({
      originX: added.originX,
      originY: added.originY,
    })
  })

  it('lets same-origin Apply supersede an in-flight pending-image placement', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template({ source: 'image' }))
    const pending = deferOneBitmap()

    const away = store.placeLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const back = store.placeLocalTemplate(added.id, added.originX, added.originY)
    pending.resolve(bitmap(1_000, 1_000))

    await expect(Promise.all([away, back])).resolves.toEqual([true, true])
    expect(store.localTemplates()[0]).toMatchObject({
      originX: added.originX,
      originY: added.originY,
      everPlaced: true,
      revision: 1,
    })
    expect(persistence.saveTemplate).toHaveBeenCalledOnce()
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ originX: added.originX, originY: added.originY, everPlaced: true }),
      null,
    )
  })

  it('notifies listeners when same-origin Apply marks a pending image placed', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template({ source: 'image' }))
    const changed = vi.fn()
    store.onLocalChange(changed)

    await expect(store.placeLocalTemplate(added.id, added.originX, added.originY)).resolves.toBe(
      true,
    )

    expect(changed).toHaveBeenCalledOnce()
    expect(store.localTemplates()[0]).toMatchObject({ everPlaced: true })
  })

  it('settles every coalesced move with the surviving durable write result', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template())
    const pending = deferOneBitmap()
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    const first = store.moveLocalTemplate('local-test', 100, 200)
    await Promise.resolve()
    const second = store.moveLocalTemplate('local-test', 300, 400)
    pending.resolve(bitmap(1_000, 1_000))

    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(store.localTemplates()[0]).toMatchObject({ originX: 10, originY: 20 })
  })

  it('does not retain rebuilt tiles when a concurrent visibility change hides the template', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferOneBitmap()
    const replacement = bitmap(1_000, 1_000)

    const moving = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const hiding = store.setLocalVisible(added.id, false)
    await hiding
    pending.resolve(replacement)
    await moving

    expect(store.localTemplates()[0]).toMatchObject({ visible: false, originX: 100, originY: 200 })
    expect(store.localTemplates()[0]?.tiles.size).toBe(0)
    expect(replacement.close).toHaveBeenCalledOnce()
  })

  it('does not let an in-flight move resurrect a deleted template', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferOneBitmap()

    const moving = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const removing = store.removeLocalTemplate(added.id)
    pending.resolve(bitmap(1_000, 1_000))

    await expect(Promise.all([moving, removing])).resolves.toEqual([false, true])
    expect(store.localTemplates()).toEqual([])
    expect(persistence.deleteTemplate).toHaveBeenCalledWith(added.id, added.revision)
    expect(persistence.saveTemplate).toHaveBeenCalledTimes(1)
  })

  it('serializes whole mutations so one field cannot overwrite another', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockClear()
    let finishVisibility = (_result: { status: 'saved'; revision: number }): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<{ status: 'saved'; revision: number }>((resolve) => {
          finishVisibility = resolve
        }),
    )

    const hidden = store.setLocalVisible(added.id, false)
    const appearance = store.setAppearance(added.id, { ...added.appearance, opacity: 0.25 })
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledOnce())
    finishVisibility({ status: 'saved', revision: 2 })
    await Promise.all([hidden, appearance])

    expect(store.localTemplates()[0]).toMatchObject({
      visible: false,
      appearance: expect.objectContaining({ opacity: 0.25 }),
    })
  })

  it('rejects appearance values that restore would discard', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockClear()

    await expect(
      store.setAppearance(added.id, {
        ...added.appearance,
        hiddenColours: [WPLACE_PALETTE.length],
      }),
    ).resolves.toBe(false)

    expect(persistence.saveTemplate).not.toHaveBeenCalled()
    expect(store.localTemplates()[0]?.appearance).toEqual(added.appearance)
  })

  it('owns appearance arrays before the queued write can observe caller mutation', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockClear()
    const hiddenColours: number[] = []
    const changing = store.setAppearance(added.id, { ...added.appearance, hiddenColours })

    hiddenColours.push(WPLACE_PALETTE.length)
    await expect(changing).resolves.toBe(true)

    expect(store.localTemplates()[0]?.appearance.hiddenColours).toEqual([])
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ hiddenColours: [] }) }),
      added.revision,
    )
  })

  it('removes stale local state when a CAS conflict reveals a cross-tab deletion', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'missing' })

    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.5 }),
    ).resolves.toBe(false)

    expect(store.localTemplates()).toEqual([])
    expect(oldLevels.every((level) => level.close.mock.calls.length === 1)).toBe(true)
  })

  it('retains stale local state when a conflict winner is temporarily unavailable', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const oldLevels = [...(added.tiles.values().next().value?.levels ?? [])] as TestBitmap[]
    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    await expect(store.moveLocalTemplate(added.id, 30, 40)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ id: added.id, originX: 10, originY: 20 })
    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
    expect(oldLevels.every((level) => !level.close.mock.calls.length)).toBe(true)
  })

  it('adopts the durable winner after a non-delete CAS conflict', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({
      status: 'loaded',
      template: {
        ...template({ originX: 30, originY: 40 }),
        visible: true,
        everPlaced: true,
        revision: 2,
      },
    })

    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.5 }),
    ).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ originX: 30, originY: 40, revision: 2 })
  })

  it('releases a large losing slice before building the conflict winner', async () => {
    const store = await import('./local-store.js')
    const indices = new Uint8Array(11_001).fill(0)
    const large = await store.addLocalTemplate(
      template({ id: 'large', originX: 0, width: indices.length, indices, opaque: indices.length }),
    )
    await store.addLocalTemplate(template({ id: 'other', originX: 20_000 }))
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({
      status: 'loaded',
      template: {
        ...template({
          id: 'large',
          originX: 2,
          width: indices.length,
          indices,
          opaque: indices.length,
        }),
        visible: true,
        everPlaced: true,
        revision: 2,
      },
    })

    await expect(store.moveLocalTemplate(large.id, 1, 0)).resolves.toBe(false)

    expect(store.localTemplates().find(({ id }) => id === large.id)).toMatchObject({
      originX: 2,
      revision: 2,
    })
  })

  it('restores hidden templates lazily and discards unfinished image placements', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template({ id: 'hidden' }), visible: false, everPlaced: true },
      {
        ...template({ id: 'unfinished', source: 'image' }),
        visible: true,
        everPlaced: false,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toHaveLength(1)
    expect(store.localTemplates()[0]).toMatchObject({ id: 'hidden', visible: false })
    expect(store.localTemplates()[0]?.tiles.size).toBe(0)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(persistence.deleteTemplate).toHaveBeenCalledWith('unfinished', 0)
  })

  it('restores pixels cloned into a different Uint8Array realm', async () => {
    const foreignIndices = new Uint8Array([0])
    class SandboxUint8Array extends Uint8Array {}
    vi.stubGlobal('Uint8Array', SandboxUint8Array)
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ indices: foreignIndices }),
        visible: true,
        everPlaced: true,
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toHaveLength(1)
    expect(store.localTemplates()[0]?.indices).toBe(foreignIndices)
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

  it('builds the complete source mip chain down to 125 pixels', async () => {
    const store = await import('./local-store.js')

    const added = await store.addLocalTemplate(template())

    expect(added.tiles.get('0/0')?.levels.map(({ width }) => width)).toEqual([1_000, 500, 250, 125])
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
    expect(stamp?.levels.map((level) => level.width)).toEqual([1_182])

    await store.moveLocalTemplate(added.id, 30, 40)

    expect(
      stamp?.levels.every((level) => (level as TestBitmap).close.mock.calls.length === 1),
    ).toBe(true)
  })

  it('caps a high-zoom shaped stamp so all 24 retained tiles fit the cache', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [],
    } as const

    store.stampTile(added, '0/0', appearance, 3_000)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 3_000)?.levels[0]?.width).toBe(1_182),
    )
  })

  it('reuses a shaped stamp when only draw-time opacity changes', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [],
    } as const

    await store.setAppearance(added.id, appearance)
    const styled = store.localTemplates()[0]
    if (styled === undefined) throw new Error('expected template')
    store.stampTile(styled, '0/0', styled.appearance, 1_000)
    await vi.waitFor(() =>
      expect(store.stampTile(styled, '0/0', styled.appearance, 1_000)).not.toBe(
        styled.tiles.get('0/0'),
      ),
    )
    const cached = store.stampTile(styled, '0/0', styled.appearance, 1_000)
    await store.setAppearance(styled.id, { ...appearance, opacity: 0.25 })
    const current = store.localTemplates()[0]
    if (current === undefined) throw new Error('expected template')

    expect(store.stampTile(current, '0/0', current.appearance, 1_000)).toBe(cached)
    expect(cached?.levels.every((level) => !(level as TestBitmap).close.mock.calls.length)).toBe(
      true,
    )
  })

  it('coalesces queued stamp requests to the latest zoom bucket per tile', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [],
    } as const
    const buildsBefore = vi.mocked(createImageBitmap).mock.calls.length

    store.stampTile(added, '0/0', appearance, 250)
    store.stampTile(added, '0/0', appearance, 500)
    store.stampTile(added, '0/0', appearance, 1_000)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 1_000)?.levels[0]?.width).toBe(1_182),
    )

    // One build won the queue. It needs three bitmap stages: 3000 -> 1500 -> cache-safe 1182.
    expect(vi.mocked(createImageBitmap).mock.calls.length - buildsBefore).toBe(3)
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

    expect(stamp?.levels.map((level) => level.width)).toEqual([500])
  })

  it('keeps a colour-filtered stamp visible while rebuilding it for a new zoom bucket', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const source = added.tiles.get('0/0')
    if (source === undefined) throw new Error('expected source tile')
    const appearance = {
      shape: 'full',
      size: 1,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [0],
    } as const

    store.stampTile(added, '0/0', appearance, 1_000)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 1_000)?.levels[0]?.width).toBe(1_000),
    )
    const previous = store.stampTile(added, '0/0', appearance, 1_000)
    expect(previous).not.toBe(source)

    expect(store.stampTile(added, '0/0', appearance, 250)).toBe(previous)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 250)?.levels[0]?.width).toBe(250),
    )
    expect(
      previous?.levels.every((level) => (level as TestBitmap).close.mock.calls.length === 1),
    ).toBe(true)
  })

  it('cancels a stale zoom-bucket build when the exact cached bucket is requested again', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const appearance = {
      shape: 'full',
      size: 1,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [0],
    } as const

    store.stampTile(added, '0/0', appearance, 1_000)
    await vi.waitFor(() =>
      expect(store.stampTile(added, '0/0', appearance, 1_000)?.levels[0]?.width).toBe(1_000),
    )
    const cached = store.stampTile(added, '0/0', appearance, 1_000)
    const buildsBeforeReversal = vi.mocked(createImageBitmap).mock.calls.length
    vi.useFakeTimers()

    expect(store.stampTile(added, '0/0', appearance, 250)).toBe(cached)
    expect(store.stampTile(added, '0/0', appearance, 1_000)).toBe(cached)
    await vi.runAllTimersAsync()

    expect(store.stampTile(added, '0/0', appearance, 1_000)).toBe(cached)
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(buildsBeforeReversal)
    expect(cached?.levels.every((level) => !(level as TestBitmap).close.mock.calls.length)).toBe(
      true,
    )
  })

  it('backs off a persistent stamp failure and wakes after a wall-clock rollback', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(
      template({
        originX: 999,
        originY: 0,
        width: 2,
        height: 1,
        indices: new Uint8Array([0, 0]),
        opaque: 2,
      }),
    )
    const appearance = {
      shape: 'full',
      size: 1,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [1],
    } as const
    const buildsBeforeFailure = vi.mocked(createImageBitmap).mock.calls.length
    vi.useFakeTimers()
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('GPU allocation failed'))

    expect(store.stampTile(added, '0/0', appearance, 1_000)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(buildsBeforeFailure + 1)

    for (let frame = 0; frame < 10; frame++) {
      expect(store.stampTile(added, '0/0', appearance, 1_000)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(buildsBeforeFailure + 1)

    expect(store.stampTile(added, '1/0', appearance, 1_000)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.stampTile(added, '1/0', appearance, 1_000)).toBeDefined()

    let retried: TileLevels | undefined
    const repaint = vi.fn(() => {
      retried = store.stampTile(added, '0/0', appearance, 1_000)
    })
    store.onLocalChange(repaint)

    await vi.advanceTimersByTimeAsync(999)
    expect(repaint).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() - 10_000)
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    expect(repaint).toHaveBeenCalled()
    expect(retried).toBeDefined()
  })

  it('closes an oversized stamp when a required downsample context is unavailable', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const appearance = {
      shape: 'circle',
      size: 1 / 3,
      anchor: 'c',
      opacity: 1,
      hiddenColours: [1],
    } as const
    const buildsBeforeFailure = vi.mocked(createImageBitmap).mock.calls.length
    missingContextWidth = 1_500
    vi.useFakeTimers()

    expect(store.stampTile(added, '0/0', appearance, 1_000)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(buildsBeforeFailure + 1)
    expect(createdBitmaps.at(-1)?.close).toHaveBeenCalledOnce()
    for (let frame = 0; frame < 5; frame++) {
      expect(store.stampTile(added, '0/0', appearance, 1_000)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(buildsBeforeFailure + 1)
  })

  it('evicts least-recently-used stamped tiles instead of retaining an unbounded cache', async () => {
    const store = await import('./local-store.js')
    const sourceTiles = new Map<string, TileLevels>()
    for (let tileX = 0; tileX < 34; tileX++) {
      sourceTiles.set(`${tileX}/0`, {
        levels: [bitmap(1_000, 1_000) as unknown as ImageBitmap],
      })
    }
    const placed = {
      ...template({
        width: 34_000,
        height: 1,
        indices: new Uint8Array(34_000),
        opaque: 34_000,
      }),
      tiles: sourceTiles,
      visible: true,
      everPlaced: true,
      appearance: { shape: 'full', size: 1, anchor: 'c', opacity: 1, hiddenColours: [1] },
    } as unknown as PlacedTemplate

    for (let tileX = 0; tileX < 34; tileX++) {
      store.stampTile(placed, `${tileX}/0`, placed.appearance)
      await vi.waitFor(() =>
        expect(store.stampTile(placed, `${tileX}/0`, placed.appearance)).toBeDefined(),
      )
    }

    expect(createdBitmaps[0]?.close).toHaveBeenCalledOnce()
    expect(store.stampTile(placed, '0/0', placed.appearance)).toBeUndefined()
  })

  it('exports the exact quantised indices without a browser canvas allocation', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())

    const png = await store.templateAsPng(added)

    expect(png?.type).toBe('image/png')
    if (png === null) throw new Error('expected PNG')
    const decoded = await decodePng(new Uint8Array(await png.arrayBuffer()))
    expect(decoded).toMatchObject({ width: 1, height: 1 })
    expect(decoded.pixels).toEqual(new Uint8Array([...(WPLACE_PALETTE[0]?.rgb ?? []), 255]))
    expect(contextOptions).not.toContainEqual({ colorSpace: 'srgb' })
  })
})
