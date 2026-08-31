import { decodePng, TRANSPARENT_INDEX, WORLD_PIXELS, WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedTemplate } from './import.js'

const persistence = vi.hoisted(() => ({
  deleteTemplate: vi.fn(
    async (): Promise<
      { status: 'saved'; revision: number } | { status: 'conflict' } | { status: 'unavailable' }
    > => ({ status: 'saved', revision: 1 }),
  ),
  loadTemplate: vi.fn(
    async (): Promise<
      | { status: 'loaded'; template: unknown }
      | { status: 'missing' }
      | { status: 'invalid'; revision: number }
      | { status: 'unavailable' }
    > => ({ status: 'missing' }),
  ),
  loadTemplates: vi.fn(
    async (
      _maxTemplates?: number,
      _maxIndexPixels?: number,
      _excludedRevisions?: ReadonlyMap<string, number>,
    ): Promise<unknown[]> => [],
  ),
  saveTemplate: vi.fn(
    async (
      _template: unknown,
      expectedRevision: number | null,
    ): Promise<
      | { status: 'saved'; revision: number }
      | { status: 'conflict' }
      | { status: 'limit' }
      | { status: 'unavailable' }
    > => ({ status: 'saved', revision: (expectedRevision ?? 0) + 1 }),
  ),
  saveTemplateFolders: vi.fn(
    async (
      updates: readonly { id: string; expectedRevision: number; folderId: string | null }[],
    ): Promise<
      | { status: 'saved'; revisions: ReadonlyMap<string, number> }
      | { status: 'conflict' }
      | { status: 'unavailable' }
    > => ({
      status: 'saved',
      revisions: new Map(
        updates.map(({ id, expectedRevision }) => [id, expectedRevision + 1] as const),
      ),
    }),
  ),
}))

vi.mock('./persist.js', () => persistence)
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))

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

const deferPaintedTileScan = (): { resolve: (_ignored?: unknown) => void } => {
  let release = (): void => undefined
  let blocked = false
  const pending = new Promise<void>((done) => {
    release = done
  })
  vi.stubGlobal('scheduler', {
    yield: vi.fn(async () => {
      if (blocked) return
      blocked = true
      await pending
    }),
  })
  return { resolve: () => release() }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', {})
  vi.stubGlobal('GM_setValue', vi.fn())
  vi.stubGlobal('createImageBitmap', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local template lifecycle', () => {
  it('persists alliance scope and rejects a folder from another surface', async () => {
    const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
    const { setState } = await import('../state.js')
    setState({
      localFolders: [
        { id: 'hq', parentId: null, name: 'HQ', visible: true, surface },
        {
          id: 'world',
          parentId: null,
          name: 'World',
          visible: true,
          surface: { kind: 'world', allianceId: null },
        },
      ],
    })
    const store = await import('./local-store.js')

    const added = await store.addLocalTemplate(template({ originX: -10, originY: -20 }), surface)

    expect(added.surface).toEqual(surface)
    expect(added.tiles.size).toBe(0)
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ surface }),
      null,
    )
    await expect(store.setTemplateFolder(added.id, 'world')).resolves.toBe(false)
    await expect(store.setTemplateFolder(added.id, 'hq')).resolves.toBe(true)
  })

  it('includes concurrent reservations when admitting a larger reconciliation winner', async () => {
    const { indexIncreaseWithinBudget } = await import('./local-store.js')

    expect(indexIncreaseWithinBudget(40, 20, 1, 20, 64)).toBeNull()
    expect(indexIncreaseWithinBudget(40, 0, 1, 20, 64)).toBe(19)
  })

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

  it('restores a valid persisted record without allocating browser bitmaps', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template({ id: 'valid' }), visible: true, everPlaced: true },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toEqual([
      expect.objectContaining({ id: 'valid', visible: true, tiles: new Set(['0/0']) }),
    ])
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
  })

  it('preserves durable visibility through later mutations', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      { ...template({ id: 'valid' }), visible: true, everPlaced: true },
    ])
    const store = await import('./local-store.js')
    await store.restoreLocalTemplates()
    persistence.saveTemplate.mockClear()
    const restored = store.localTemplates()[0]
    if (restored === undefined) throw new Error('expected restored template')

    await expect(
      store.setAppearance('valid', {
        ...restored.appearance,
        opacity: 0.5,
      }),
    ).resolves.toBe(true)

    expect(store.localTemplates()[0]).toMatchObject({ visible: true, revision: 1 })
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'valid', visible: true }),
      0,
    )

    persistence.saveTemplate.mockClear()
    await expect(store.moveLocalTemplate('valid', 30, 40)).resolves.toBe(true)
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'valid', visible: true, originX: 30, originY: 40 }),
      1,
    )

    persistence.saveTemplate.mockClear()
    await expect(store.setLocalVisible('valid', false)).resolves.toBe(true)
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'valid', visible: false }),
      2,
    )
  })

  it('preserves persisted appearance while restoring', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'styled' }),
        visible: false,
        everPlaced: true,
        appearance: {
          size: 1 / 3,
          radius: 1,
          translateX: 0,
          translateY: 0,
          rotation: 0,
          opacity: 0.25,
          hiddenColours: [1],
        },
      },
    ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()[0]?.appearance).toMatchObject({
      size: 1 / 3,
      radius: 1,
      opacity: 0.25,
      hiddenColours: [1],
    })
  })

  it('repairs a cross-tab assignment whose Local folder was deleted', async () => {
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: 'orphaned', source: 'marble' }),
        visible: false,
        everPlaced: true,
        folderId: 'deleted-in-another-tab',
        revision: 4,
      },
    ])
    const { setState } = await import('../state.js')
    setState({ localFolders: [] })
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(persistence.saveTemplateFolders).toHaveBeenCalledWith([
      { id: 'orphaned', expectedRevision: 4, folderId: null },
    ])
    expect(store.localTemplates()).toEqual([
      expect.objectContaining({ id: 'orphaned', folderId: null, revision: 5 }),
    ])
  })

  it('retries past a transient hydration failure without deleting its durable record', async () => {
    persistence.loadTemplates
      .mockResolvedValueOnce([
        {
          kind: 'template-hydration-failure',
          status: 'unavailable',
          id: 'unavailable',
          revision: 2,
          indexPixels: 1,
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
    expect(persistence.loadTemplates.mock.calls[1]?.[2]).toEqual(
      new Map([
        ['unavailable', 2],
        ['valid', 0],
      ]),
    )
  })

  it('excludes only the unavailable revision and restores a newer cross-tab replacement', async () => {
    persistence.loadTemplates
      .mockResolvedValueOnce([
        {
          kind: 'template-hydration-failure',
          status: 'unavailable',
          id: 'replaced',
          revision: 1,
          indexPixels: 1,
        },
      ])
      .mockImplementationOnce(async (_templates, _pixels, exclusions) => {
        expect(exclusions).toEqual(new Map([['replaced', 1]]))
        return [
          {
            ...template({ id: 'replaced', source: 'marble' }),
            visible: false,
            everPlaced: true,
            revision: 2,
          },
        ]
      })
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()

    expect(store.localTemplates()).toEqual([
      expect.objectContaining({ id: 'replaced', revision: 2 }),
    ])
  })

  it('retries startup restore once a blocked persistence open becomes retryable', async () => {
    let recover = (): void => undefined
    const retryAfterUnavailable = new Promise<void>((resolve) => {
      recover = resolve
    })
    const unavailable = [] as unknown[] & { retryAfterUnavailable?: Promise<void> | null }
    Object.defineProperty(unavailable, 'retryAfterUnavailable', {
      value: retryAfterUnavailable,
      enumerable: false,
    })
    persistence.loadTemplates
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce([
        { ...template({ id: 'recovered', source: 'marble' }), visible: false, everPlaced: true },
      ])
    const store = await import('./local-store.js')

    await store.restoreLocalTemplates()
    await store.restoreLocalTemplates()
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(2)
    expect(store.localTemplates()).toEqual([])
    recover()

    await vi.waitFor(() => expect(persistence.loadTemplates).toHaveBeenCalledTimes(3))
    await vi.waitFor(() =>
      expect(store.localTemplates().map(({ id }) => id)).toEqual(['recovered']),
    )
    await Promise.resolve()
    expect(persistence.loadTemplates).toHaveBeenCalledTimes(3)
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

  it('rejects duplicate restore records before scanning their pixels', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    vi.stubGlobal('scheduler', undefined)
    const yieldToBrowser = vi.spyOn(globalThis, 'setTimeout')
    const indices = new Uint8Array(1_000_000).fill(63)
    indices[0] = 0
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({ id: added.id, originX: 0, width: indices.length, indices, opaque: 1 }),
        visible: false,
        everPlaced: true,
      },
    ])

    await store.restoreLocalTemplates()

    expect(yieldToBrowser).not.toHaveBeenCalled()
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
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
    Object.defineProperty(window, '__caelestisLocal', {
      value: [],
      writable: false,
      configurable: true,
    })
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

    expect(pageRealm.__caelestisLocal).toEqual([
      expect.objectContaining({ id: 'local-test', originX: 10, originY: 20 }),
    ])
    expect((window as unknown as Record<string, unknown>).__caelestisLocal).toBeUndefined()
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

  it('keeps a Local template alive while a deletion lease is held', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const release = store.leaseLocalTemplate(added.id)

    expect(release).not.toBeNull()
    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(false)
    expect(store.localTemplates()).toContain(added)

    release?.()
    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(true)
    expect(store.localTemplates()).toEqual([])
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
    const durableChanged = vi.fn()
    const previewChanged = vi.fn()
    store.onLocalChange(durableChanged)
    store.onLocalPreviewChange(previewChanged)

    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)

    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
    expect(store.localTemplates()[0]?.originX).toBe(10)
    expect(store.displayTemplates()[0]).toMatchObject({ originX: 30, originY: 40 })
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(persistence.saveTemplate).not.toHaveBeenCalled()
    expect(durableChanged).not.toHaveBeenCalled()
    expect(previewChanged).toHaveBeenCalledOnce()
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

  it('keeps the old placement when a move cannot be saved', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    await expect(store.moveLocalTemplate(added.id, 30, 40)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ originX: 10, originY: 20 })
  })

  it('does not report unsaved delete, visibility, or appearance mutations in memory', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const originalOpacity = store.appearanceOf(added).opacity

    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    await expect(store.setLocalVisible(added.id, false)).resolves.toBe(false)
    expect(store.localTemplates()[0]?.visible).toBe(true)

    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.25 }),
    ).resolves.toBe(false)
    const unchanged = store.localTemplates()[0]
    expect(unchanged === undefined ? undefined : store.appearanceOf(unchanged).opacity).toBe(
      originalOpacity,
    )

    persistence.deleteTemplate.mockResolvedValueOnce({ status: 'unavailable' })
    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)
    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(false)
    expect(store.localTemplates()).toHaveLength(1)
    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
  })

  it('keeps a pending image local when the cross-tab durable aggregate limit rejects creation', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template({ source: 'image' }))
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'limit' })

    await expect(store.placeLocalTemplate(added.id, added.originX, added.originY)).resolves.toBe(
      false,
    )

    expect(store.localTemplates()).toEqual([
      expect.objectContaining({ id: added.id, everPlaced: false, revision: 0 }),
    ])
    expect(persistence.loadTemplate).not.toHaveBeenCalled()
  })

  it('reports a deletion reconciled to durable absence as successful', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.deleteTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'missing' })

    await expect(store.removeLocalTemplate(added.id)).resolves.toBe(true)

    expect(store.localTemplates()).toEqual([])
  })

  it('reports success when an earlier queued reconciliation removes the template before deletion runs', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockClear()
    let finishMutation = (_result: { status: 'conflict' }): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<{ status: 'conflict' }>((resolve) => {
          finishMutation = resolve
        }),
    )
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'missing' })

    const mutating = store.setAppearance(added.id, { ...added.appearance, opacity: 0.5 })
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledOnce())
    const removing = store.removeLocalTemplate(added.id)
    finishMutation({ status: 'conflict' })

    await expect(mutating).resolves.toBe(false)
    await expect(removing).resolves.toBe(true)
    expect(store.localTemplates()).toEqual([])
    expect(persistence.deleteTemplate).not.toHaveBeenCalled()
  })

  it('keeps compact painted-tile keys while visibility changes', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(
      template({
        originX: 999,
        originY: 0,
        width: 2,
        height: 1,
        indices: new Uint8Array([0, 1]),
        opaque: 2,
      }),
    )

    await expect(store.setLocalVisible(added.id, false)).resolves.toBe(true)
    expect(store.localTemplates()[0]?.tiles).toEqual(new Set(['0/0', '1/0']))
    await expect(store.setLocalVisible(added.id, true)).resolves.toBe(true)
    expect(store.localTemplates()[0]?.tiles).toEqual(new Set(['0/0', '1/0']))
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('admits more than twelve painted tiles without allocating source bitmaps', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(
      template({
        originX: 0,
        originY: 0,
        width: 13_000,
        height: 1,
        indices: new Uint8Array(13_000),
        opaque: 13_000,
      }),
    )

    expect(added.tiles.size).toBe(13)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('moves a hidden template across more than twelve painted tiles', async () => {
    const indices = new Uint8Array(12_000)
    persistence.loadTemplates.mockResolvedValueOnce([
      {
        ...template({
          originX: 0,
          originY: 0,
          width: indices.length,
          indices,
          opaque: indices.length,
        }),
        visible: false,
        everPlaced: true,
      },
    ])
    const store = await import('./local-store.js')
    await store.restoreLocalTemplates()
    persistence.saveTemplate.mockClear()

    await expect(store.moveLocalTemplate('local-test', 1, 0)).resolves.toBe(true)

    expect(store.localTemplates()[0]).toMatchObject({ originX: 1, originY: 0, visible: false })
    expect(store.localTemplates()[0]?.tiles.size).toBe(13)
    expect(persistence.saveTemplate).toHaveBeenCalledOnce()
  })

  it('skips sparse empty tile rows without allocating rendered buffers for them', async () => {
    const store = await import('./local-store.js')
    const height = 2_047_001
    const indices = new Uint8Array(height).fill(TRANSPARENT_INDEX)
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
    const pending = deferPaintedTileScan()

    const first = store.moveLocalTemplate('local-test', 100, 200)
    await Promise.resolve()
    const second = store.moveLocalTemplate('local-test', 300, 400)
    pending.resolve()
    await Promise.all([first, second])

    expect(store.localTemplates()[0]).toMatchObject({ originX: 300, originY: 400 })
  })

  it('lets a return to the installed origin supersede an in-flight move', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferPaintedTileScan()

    const away = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const back = store.moveLocalTemplate(added.id, added.originX, added.originY)
    pending.resolve()

    await expect(Promise.all([away, back])).resolves.toEqual([true, true])
    expect(store.localTemplates()[0]).toMatchObject({
      originX: added.originX,
      originY: added.originY,
    })
  })

  it('lets same-origin Apply supersede an in-flight pending-image placement', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template({ source: 'image' }))
    const pending = deferPaintedTileScan()

    const away = store.placeLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const back = store.placeLocalTemplate(added.id, added.originX, added.originY)
    pending.resolve()

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
    const pending = deferPaintedTileScan()
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    const first = store.moveLocalTemplate('local-test', 100, 200)
    await Promise.resolve()
    const second = store.moveLocalTemplate('local-test', 300, 400)
    pending.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(store.localTemplates()[0]).toMatchObject({ originX: 10, originY: 20 })
  })

  it('keeps painted-tile keys when a concurrent visibility change hides the template', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferPaintedTileScan()

    const moving = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const hiding = store.setLocalVisible(added.id, false)
    await hiding
    pending.resolve()
    await moving

    expect(store.localTemplates()[0]).toMatchObject({ visible: false, originX: 100, originY: 200 })
    expect(store.localTemplates()[0]?.tiles.size).toBe(1)
  })

  it('keeps the old placement when a hidden concurrent move finds invalid pixels', async () => {
    const store = await import('./local-store.js')
    const indices = new Uint8Array([0, 0])
    const added = await store.addLocalTemplate(
      template({ width: 2, indices, opaque: indices.length }),
    )
    // Imported typed arrays cross an exported API boundary. Simulate an external owner mutating a
    // byte after admission so the in-flight scan observes invalid external state.
    indices[0] = 255
    const pending = deferPaintedTileScan()

    const moving = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    await store.setLocalVisible(added.id, false)
    pending.resolve()

    await expect(moving).rejects.toThrow(/palette index/i)
    expect(store.localTemplates()[0]).toMatchObject({ visible: false, originX: 10, originY: 20 })
  })

  it('does not let an in-flight move resurrect a deleted template', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferPaintedTileScan()

    const moving = store.moveLocalTemplate(added.id, 100, 200)
    await Promise.resolve()
    const removing = store.removeLocalTemplate(added.id)
    pending.resolve()

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

  it('serializes conflict hydration globally across different template ids', async () => {
    const store = await import('./local-store.js')
    const first = await store.addLocalTemplate(template({ id: 'first' }))
    const second = await store.addLocalTemplate(template({ id: 'second', originX: 30 }))
    persistence.saveTemplate.mockClear()
    persistence.saveTemplate
      .mockResolvedValueOnce({ status: 'conflict' })
      .mockResolvedValueOnce({ status: 'conflict' })
    let finishFirstLoad = (_result: { status: 'missing' }): void => undefined
    persistence.loadTemplate
      .mockImplementationOnce(
        async () =>
          await new Promise<{ status: 'missing' }>((resolve) => {
            finishFirstLoad = resolve
          }),
      )
      .mockResolvedValue({ status: 'missing' })

    const firstMutation = store.setAppearance(first.id, { ...first.appearance, opacity: 0.5 })
    const secondMutation = store.setAppearance(second.id, { ...second.appearance, opacity: 0.5 })
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledTimes(2))

    expect(persistence.loadTemplate).toHaveBeenCalledOnce()
    finishFirstLoad({ status: 'missing' })
    await Promise.all([firstMutation, secondMutation])
    expect(persistence.loadTemplate).toHaveBeenCalledTimes(2)
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

    const current = store.localTemplates()[0]
    expect(current === undefined ? undefined : store.appearanceOf(current).hiddenColours).toEqual(
      [],
    )
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ hiddenColours: [] }) }),
      added.revision,
    )
  })

  it('merges queued marker toggles and opacity changes against the latest appearance', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    await store.setOwnsGroup(added.id, 'markers', true)
    await store.setOwnsGroup(added.id, 'pixels', true)
    persistence.saveTemplate.mockClear()
    let finishFirst = (_value: { status: 'saved'; revision: number }): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<{ status: 'saved'; revision: number }>((resolve) => {
          finishFirst = resolve
        }),
    )

    const mismatch = store.toggleAppearanceBoolean(added.id, 'markMismatch')
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledOnce())
    const selected = store.toggleAppearanceBoolean(added.id, 'markSelectedColour')
    const opacity = store.setAppearance(added.id, { opacity: 0.2 })
    finishFirst({ status: 'saved', revision: added.revision + 1 })

    await expect(Promise.all([mismatch, selected, opacity])).resolves.toEqual([true, true, true])
    const current = store.localTemplates()[0]
    expect(current === undefined ? null : store.appearanceOf(current)).toMatchObject({
      markMismatch: true,
      markSelectedColour: true,
      opacity: 0.2,
    })
  })

  it('removes stale local state when a CAS conflict reveals a cross-tab deletion', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'missing' })

    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.5 }),
    ).resolves.toBe(false)

    expect(store.localTemplates()).toEqual([])
  })

  it('retains stale local state when a conflict winner is temporarily unavailable', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    expect(store.previewLocalTemplate(added.id, 30, 40)).toBe(true)
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({ status: 'unavailable' })

    await expect(store.moveLocalTemplate(added.id, 30, 40)).resolves.toBe(false)

    expect(store.localTemplates()[0]).toMatchObject({ id: added.id, originX: 10, originY: 20 })
    expect(store.previewOriginFor(added.id)).toEqual({ x: 30, y: 40 })
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

  it('adopts a valid conflict winner without allocating source bitmaps', async () => {
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

    expect(store.localTemplates()[0]).toMatchObject({
      originX: 30,
      originY: 40,
      revision: 2,
      visible: true,
    })
    expect(store.localTemplates()[0]?.tiles).toEqual(new Set(['0/0']))
    expect(createImageBitmap).not.toHaveBeenCalled()

    persistence.saveTemplate.mockClear()
    await expect(
      store.setAppearance(added.id, { ...added.appearance, opacity: 0.25 }),
    ).resolves.toBe(true)
    expect(persistence.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: added.id, visible: true }),
      2,
    )
  })

  it('adopts a conflict winner after scanning a large losing move', async () => {
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

  it('rescans a move when reconciliation replaces its source pixels', async () => {
    const store = await import('./local-store.js')
    const added = await store.addLocalTemplate(template())
    const pending = deferPaintedTileScan()
    const moving = store.moveLocalTemplate(added.id, 30, 40)
    await Promise.resolve()
    persistence.saveTemplate.mockResolvedValueOnce({ status: 'conflict' })
    persistence.loadTemplate.mockResolvedValueOnce({
      status: 'loaded',
      template: {
        ...template({ width: 2, indices: new Uint8Array([0, 0]), opaque: 2 }),
        visible: true,
        everPlaced: true,
        revision: 2,
      },
    })

    await store.setAppearance(added.id, { ...added.appearance, opacity: 0.5 })
    pending.resolve()
    await moving

    const final = store.localTemplates()[0]
    expect(final).toMatchObject({ width: 2, originX: 30, originY: 40 })
    expect(final?.tiles).toEqual(new Set(['0/0']))
  })

  it('restores hidden template tile keys and discards unfinished image placements', async () => {
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
    expect(store.localTemplates()[0]?.tiles).toEqual(new Set(['0/0']))
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

  it('refreshes server metadata without rebuilding unchanged pixels', async () => {
    const store = await import('./local-store.js')
    await store.putServerTemplate({
      ...template({ id: 'srv:https://example.test:template-1', name: 'Before' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-before',
      serverVersion: 'version-1',
    })
    const before = store.localTemplates()[0]

    await expect(
      store.updateServerTemplateMetadata(
        'srv:https://example.test:template-1',
        'After',
        'folder-after',
      ),
    ).resolves.toBe(true)

    const after = store.localTemplates()[0]
    expect(after).toMatchObject({ name: 'After', serverNodeId: 'folder-after' })
    expect(after?.indices).toBe(before?.indices)
    expect(after?.tiles).toBe(before?.tiles)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('hides a server overlay as soon as its connection lifetime is replaced', async () => {
    const { setState } = await import('../state.js')
    const server = {
      url: 'https://example.test',
      info: {
        id: '019fed50-87a1-7523-a88c-bdeafad49681',
        name: 'Example',
        auth: 'none' as const,
      },
      token: 'old-token',
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    setState({ servers: [server] })
    const store = await import('./local-store.js')
    await store.putServerTemplate({
      ...template({ id: 'srv:https://example.test:template-1' }),
      serverUrl: server.url,
      serverTemplateId: 'template-1',
      serverNodeId: null,
      serverVersion: 'version-1',
      serverConnection: server,
    })
    const installed = store.localTemplates()[0]
    if (installed === undefined) throw new Error('expected installed server template')
    expect(store.isTemplateVisible(installed)).toBe(true)

    setState({ servers: [{ ...server, token: 'new-token' }] })

    expect(store.isTemplateVisible(installed)).toBe(false)
  })

  it('forgets one server drawing surface without removing its other overlays', async () => {
    const store = await import('./local-store.js')
    const common = {
      serverUrl: 'https://example.test',
      serverNodeId: null,
      serverVersion: 'version-1',
    }
    await store.putServerTemplate({
      ...template({ id: 'srv:https://example.test:world', name: 'World' }),
      ...common,
      serverTemplateId: 'world',
    })
    const surface = { kind: 'alliance-banner', allianceId: 535_245 } as const
    await store.putServerTemplate({
      ...template({ id: 'srv:https://example.test:alliance', name: 'Alliance' }),
      ...common,
      surface,
      serverTemplateId: 'alliance',
    })

    await store.forgetServerSurfaceTemplates(common.serverUrl, surface)

    expect(store.localTemplates().map(({ name }) => name)).toEqual(['World'])
  })

  it('admits server overlays by pixel budget without prebuilding source bitmaps', async () => {
    const store = await import('./local-store.js')

    for (let index = 0; index < 93; index++) {
      await store.putServerTemplate({
        ...template({ id: `srv:https://example.test:template-${index}`, originX: index }),
        serverUrl: 'https://example.test',
        serverTemplateId: `template-${index}`,
        serverNodeId: null,
        serverVersion: 'version-1',
      })
    }

    expect(store.localTemplates()).toHaveLength(93)
    expect(store.localTemplates().every((candidate) => candidate.tiles.size === 0)).toBe(true)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('derives compact tile keys when copying a server overlay into Local', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: 'srv:https://example.test:template-1' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: null,
      serverVersion: 'version-1',
      serverTileKeys: ['0/0'],
    }
    await store.putServerTemplate(serverTemplate)
    const installed = store.localTemplates()[0]
    expect(installed?.tiles.size).toBe(0)
    if (installed === undefined) throw new Error('server template was not installed')

    const copied = await store.copyAsLocalTemplate(installed, 'local-copy')

    expect(store.isServerTemplate(copied)).toBe(false)
    expect(copied.tiles.size).toBe(1)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('serializes same-version server metadata after an in-flight user mutation', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: 'srv:https://example.test:template-1', name: 'Before' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-before',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)

    const hiding = store.setLocalVisible(serverTemplate.id, false)
    await Promise.resolve()
    const refreshing = store.updateServerTemplateMetadata(
      serverTemplate.id,
      'After',
      'folder-after',
    )

    await expect(hiding).resolves.toBe(true)
    await expect(refreshing).resolves.toBe(true)
    expect(store.localTemplates()[0]).toMatchObject({
      name: 'After',
      serverNodeId: 'folder-after',
      visible: false,
    })
  })

  it('keeps server appearance preferences after removal and republication', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: `srv:${encodeURIComponent('https://example.test')}:template-1` }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    await expect(store.setOwnsGroup(serverTemplate.id, 'pixels', true)).resolves.toBe(true)
    const current = store.localTemplates()[0]
    expect(current).toBeDefined()
    if (current === undefined) throw new Error('server template was not installed')
    await expect(
      store.setAppearance(serverTemplate.id, { ...store.appearanceOf(current), opacity: 0.25 }),
    ).resolves.toBe(true)

    await store.forgetServerTemplate(serverTemplate.id)
    await store.putServerTemplate({ ...serverTemplate, serverVersion: 'version-2' })

    expect(store.localTemplates()[0]).toMatchObject({
      appearance: { opacity: 0.25 },
      owns: ['pixels'],
    })
  })

  it('serializes a server refresh ahead of a concurrent visibility change', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: `srv:${encodeURIComponent('https://example.test')}:template-1` }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    const refreshing = store.putServerTemplate({ ...serverTemplate, serverVersion: 'version-2' })
    const hiding = store.setLocalVisible(serverTemplate.id, false)

    await expect(refreshing).resolves.toBe(true)
    await expect(hiding).resolves.toBe(true)
    expect(store.localTemplates()[0]).toMatchObject({ serverVersion: 'version-2', visible: false })
    expect(store.localTemplates()[0]?.tiles.size).toBe(0)
  })

  it('does not let an obsolete server install replace a reconnected generation', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: `srv:${encodeURIComponent('https://example.test')}:template-1` }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    let current = true

    const stale = store.putServerTemplate(
      { ...serverTemplate, serverVersion: 'version-2' },
      () => current,
    )
    current = false
    const forgetting = store.forgetServerTemplates(serverTemplate.serverUrl)
    const replacement = store.putServerTemplate({ ...serverTemplate, serverVersion: 'version-3' })

    await expect(stale).resolves.toBe(false)
    await expect(forgetting).resolves.toBeUndefined()
    await expect(replacement).resolves.toBe(true)
    expect(store.localTemplates()).toHaveLength(1)
    expect(store.localTemplates()[0]?.serverVersion).toBe('version-3')
  })

  it('orders manifest removal after an in-flight server visibility write', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: 'srv:https://example.test:template-1' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    await store.setLocalVisible(serverTemplate.id, false)

    const revealing = store.setLocalVisible(serverTemplate.id, true)
    const forgetting = store.forgetServerTemplate(serverTemplate.id)

    await expect(revealing).resolves.toBe(true)
    await expect(forgetting).resolves.toBeUndefined()
    expect(store.localTemplates()).toHaveLength(0)
  })

  it('orders disconnect cleanup after all in-flight server visibility writes', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: 'srv:https://example.test:template-1' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    await store.setLocalVisible(serverTemplate.id, false)

    const revealing = store.setLocalVisible(serverTemplate.id, true)
    const forgetting = store.forgetServerTemplates(serverTemplate.serverUrl)

    await expect(revealing).resolves.toBe(true)
    await expect(forgetting).resolves.toBeUndefined()
    expect(store.localTemplates()).toHaveLength(0)
  })

  it('preserves legal whitespace server names while refreshing their folder', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: 'srv:https://example.test:template-1', name: 'Before' }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-before',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)

    await expect(
      store.updateServerTemplateMetadata(serverTemplate.id, '   ', 'folder-after'),
    ).resolves.toBe(true)
    expect(store.localTemplates()[0]).toMatchObject({ name: '   ', serverNodeId: 'folder-after' })
  })

  it('keeps live server visibility unchanged when its scope cannot be saved', async () => {
    const store = await import('./local-store.js')
    const serverTemplate = {
      ...template({ id: `srv:${encodeURIComponent('https://example.test')}:template-1` }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
    }
    await store.putServerTemplate(serverTemplate)
    vi.stubGlobal(
      'GM_setValue',
      vi.fn(() => {
        throw new Error('quota exceeded')
      }),
    )

    await expect(store.setLocalVisible(serverTemplate.id, false)).resolves.toBe(false)
    expect(store.localTemplates()[0]?.visible).toBe(true)
  })

  it('places both runs of a wrapped server template into their world tiles', async () => {
    const store = await import('./local-store.js')
    await store.putServerTemplate({
      ...template({
        id: 'wrapped',
        originX: WORLD_PIXELS - 1,
        originY: 0,
        width: 2,
        height: 1,
        indices: new Uint8Array([0, 1]),
        opaque: 2,
      }),
      serverUrl: 'https://example.test',
      serverTemplateId: 'template-1',
      serverNodeId: 'folder-1',
      serverVersion: 'version-1',
      serverTileKeys: ['2047/0', '0/0'],
      wrapX: true,
    })

    const [wrapped] = store.localTemplates()
    expect(wrapped).toBeDefined()
    if (wrapped === undefined) throw new Error('wrapped template was not installed')
    expect([...store.templateTileKeys(wrapped)].sort()).toEqual(['0/0', '2047/0'])
    expect(store.canCopyAsLocalTemplate(wrapped)).toBe(false)
    expect(store.canCopyAsLocalTemplate({ ...wrapped, originX: 10 })).toBe(true)
    await expect(store.removeLocalTemplate(wrapped.id)).resolves.toBe(false)
    expect(store.localTemplates()).toContain(wrapped)
    expect(wrapped.tiles.size).toBe(0)
  })

  it('moves several folder children only after their one durable batch succeeds', async () => {
    const store = await import('./local-store.js')
    const { setState } = await import('../state.js')
    setState({
      localFolders: [{ id: 'old', parentId: null, name: 'Old', visible: true }],
    })
    await store.addLocalTemplate(template({ id: 'first' }))
    await store.addLocalTemplate(template({ id: 'second' }))
    await store.setTemplateFolder('first', 'old')
    await store.setTemplateFolder('second', 'old')
    persistence.saveTemplateFolders.mockResolvedValueOnce({ status: 'unavailable' })

    expect(await store.setTemplatesFolder(['first', 'second'], null)).toBe(false)
    expect(store.localTemplates().map(({ folderId }) => folderId)).toEqual(['old', 'old'])

    expect(await store.setTemplatesFolder(['first', 'second'], null)).toBe(true)
    expect(store.localTemplates().map(({ folderId }) => folderId)).toEqual([null, null])
  })

  it('refuses to assign a template to a missing Local folder', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template({ id: 'template' }))

    expect(await store.setTemplateFolder('template', 'deleted')).toBe(false)
    expect(store.localTemplates()[0]?.folderId).toBeNull()
  })

  it('keeps the target folder alive until its template assignment commits', async () => {
    const store = await import('./local-store.js')
    const { removeLocalFolder } = await import('../local-folders.js')
    const { setState } = await import('../state.js')
    setState({
      localFolders: [{ id: 'target', parentId: null, name: 'Target', visible: true }],
    })
    await store.addLocalTemplate(template({ id: 'template' }))
    persistence.saveTemplate.mockClear()
    let finishSave = (_value: { status: 'saved'; revision: number }): void => undefined
    persistence.saveTemplate.mockImplementationOnce(
      async () =>
        await new Promise<{ status: 'saved'; revision: number }>((resolve) => {
          finishSave = resolve
        }),
    )

    const assigning = store.setTemplateFolder('template', 'target')
    await vi.waitFor(() => expect(persistence.saveTemplate).toHaveBeenCalledOnce())

    expect(removeLocalFolder('target')).toBe(false)
    finishSave({ status: 'saved', revision: 2 })
    await expect(assigning).resolves.toBe(true)
    expect(store.localTemplates()[0]?.folderId).toBe('target')
  })

  it('renders imported source order from lowest to highest', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template({ id: 'high', sortOrder: 10 }))
    await store.addLocalTemplate(template({ id: 'low', sortOrder: 0 }))

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['low', 'high'])
  })

  it('serves identity and repeated ordered reads from the catalog generation', async () => {
    const store = await import('./local-store.js')
    await store.addLocalTemplate(template({ id: 'high', sortOrder: 10 }))
    await store.addLocalTemplate(template({ id: 'low', sortOrder: 0 }))

    const generation = store.localTemplates()
    expect(store.localTemplates()).toBe(generation)
    expect(store.templateById('low')).toBe(generation[0])
    expect(store.templateIndexMemoryBytes()).toBe(2)

    await store.renameLocalTemplate('low', 'Renamed')

    expect(store.localTemplates()).not.toBe(generation)
    expect(store.templateById('low')).toMatchObject({ name: 'Renamed' })
  })

  it('uses the durable custom tree order for display stacking', async () => {
    const store = await import('./local-store.js')
    const { setState } = await import('../state.js')
    await store.addLocalTemplate(template({ id: 'high', sortOrder: 10 }))
    await store.addLocalTemplate(template({ id: 'low', sortOrder: 0 }))
    setState({ customOrder: ['local:high', 'local:low'] })

    expect(store.localTemplates().map(({ id }) => id)).toEqual(['low', 'high'])
    expect(store.displayTemplates().map(({ id }) => id)).toEqual(['high', 'low'])
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
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
