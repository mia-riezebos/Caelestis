import { decodePng, TRANSPARENT_INDEX } from '@caelestis/shared'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeImageStore, NativeMetadataStore, NativeTemplate } from './native-store.js'
import type { StoredTemplate } from './persist.js'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const local = (overrides: Partial<StoredTemplate> = {}): StoredTemplate => ({
  id: 'local-art',
  name: 'Artwork',
  source: 'wplace',
  originX: 100,
  originY: 100,
  width: 2,
  height: 2,
  indices: new Uint8Array([0, 5, 10, TRANSPARENT_INDEX]),
  moved: 0,
  opaque: 3,
  visible: true,
  everPlaced: true,
  revision: 0,
  folderId: 'folder-a',
  owns: ['markers'],
  ...overrides,
})

const fixture = async () => {
  const rows = new Map<string, NativeTemplate>()
  const blobs = new Map<string, Blob>()
  let catalog: { name: string; colorIdx: number }[] = []
  const retainTags = (row: NativeTemplate): void => {
    for (const [index, name] of (row.tags ?? []).entries()) {
      if (!catalog.some((tag) => tag.name.toLowerCase() === name.toLowerCase()))
        catalog.push({ name, colorIdx: row.tagColorIdxs?.[index] ?? 7 })
    }
  }
  const metadata: NativeMetadataStore = {
    get tagCatalog() {
      return catalog
    },
    get templates() {
      return [...rows.values()]
    },
    placementSession: false,
    getById: (id) => rows.get(id),
    add: (row) => {
      retainTags(row)
      rows.set(row.id, row)
    },
    update: (id, patch) => {
      const before = rows.get(id)
      if (before) {
        const next = { ...before, ...patch }
        retainTags(next)
        rows.set(id, next)
      }
    },
    remove: (id) => {
      rows.delete(id)
    },
    deleteTag: (name) => {
      catalog = catalog.filter((tag) => tag.name !== name)
      for (const row of rows.values()) {
        if (row.serverManaged) continue
        const tags = row.tags ?? []
        rows.set(row.id, {
          ...row,
          tags: tags.filter((tag) => tag !== name),
          tagColorIdxs: tags.flatMap((tag, index) =>
            tag === name ? [] : [row.tagColorIdxs?.[index] ?? 7],
          ),
        })
      }
      return true
    },
    persist: vi.fn(),
    commitPendingChanges: vi.fn(),
    subscribeChange: () => () => {},
  }
  const images: NativeImageStore = {
    read: async (id) => blobs.get(id),
    save: vi.fn(async (id, blob) => {
      blobs.set(id, blob)
    }),
    remove: async (id) => {
      blobs.delete(id)
    },
    subscribe: () => () => {},
    render: async (blob) => {
      const decoded = await decodePng(new Uint8Array(await blob.arrayBuffer()))
      return {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8ClampedArray(decoded.pixels),
        colorSpace: 'srgb',
      }
    },
  }
  const adapter = await import('./native-store.js')
  const api = new adapter.NativeTemplates(metadata, images)
  const disk = await import('./persist.js')
  const personal = await import('./personal-store.js')
  personal.connectPersonalStore(api)
  const read = async (id = 'local-art') => {
    const loaded = await disk.loadTemplate(id)
    if (loaded.status !== 'loaded') throw new Error(loaded.status)
    return loaded.template as StoredTemplate
  }
  const seed = async (template = local()) => {
    expect(await disk.saveTemplate(template, null)).toMatchObject({ status: 'saved' })
    await personal.synchronizePersonalTemplates()
    return await read(template.id)
  }
  return { rows, blobs, metadata, images, adapter, api, disk, personal, read, seed }
}

describe('personal template ownership', () => {
  it('mirrors tag assignment, rename, and deletion in both directions while preserving native colours', async () => {
    const { seed, api, metadata, personal, disk, read } = await fixture()
    const tags = await import('./tags.js')
    const linked = await seed()
    const id = linked.native?.id ?? ''
    metadata.update(id, { tags: ['Repair'], tagColorIdxs: [19] })
    await personal.synchronizePersonalTemplates()
    const repair = tags.localTemplateTags(linked.id)[0]
    expect(repair?.name).toBe('Repair')
    const tagId = repair?.id ?? ''
    await tags.mutateLocalTag({ type: 'rename', id: tagId, name: 'Priority' })
    expect(api.metadata.getById(id)?.tags).toEqual(['Priority'])
    expect(api.metadata.tagCatalog?.some((tag) => tag.name === 'Repair')).toBe(false)
    expect(api.metadata.getById(id)?.tagColorIdxs).toEqual([19])
    metadata.update(id, { tags: ['Native'], tagColorIdxs: [21] })
    await personal.synchronizePersonalTemplates()
    expect(tags.localTemplateTags(linked.id).map((tag) => tag.name)).toEqual(['Native'])
    const nativeTag = tags.localTemplateTags(linked.id)[0]
    await tags.mutateLocalTag({ type: 'assign', id: tagId, templateId: linked.id, attached: true })
    expect(api.metadata.getById(id)?.tags).toEqual(['Native', 'Priority'])
    expect(api.metadata.getById(id)?.tagColorIdxs?.[0]).toBe(21)
    // An older artwork model must not overwrite the tag baseline saved by the tag transaction.
    const current = await read()
    const baseline = current.nativeTags
    const { nativeTags: _baseline, ...staleModel } = current
    await disk.saveTemplate({ ...staleModel, name: 'Renamed artwork' }, current.revision)
    expect((await read()).nativeTags).toEqual(baseline)
    await tags.mutateLocalTag({ type: 'delete', id: nativeTag?.id ?? '' })
    expect(api.metadata.getById(id)?.tags).toEqual(['Priority'])
    metadata.update(id, { tags: [], tagColorIdxs: [] })
    await personal.synchronizePersonalTemplates()
    expect(tags.localTemplateTags(linked.id)).toEqual([])
    await tags.mutateLocalTag({ type: 'assign', id: tagId, templateId: linked.id, attached: true })
    metadata.deleteTag?.('Priority')
    await personal.synchronizePersonalTemplates()
    expect(tags.localTagCatalog().some((tag) => tag.id === tagId)).toBe(false)
  })

  it('migrates fitting tags and keeps overflow, long names, and alliance assignments local', async () => {
    const { disk, personal, api, read } = await fixture()
    const tags = await import('./tags.js')
    await disk.saveTemplate(local(), null)
    const hq = local({ id: 'hq', surface: { kind: 'alliance-headquarters', allianceId: 1 } })
    await disk.saveTemplate(hq, null)
    // Simulate existing labels before the native owner is connected.
    tags.connectLocalTagSync(async () => {})
    const names = [
      ...Array.from({ length: 10 }, (_, index) => `Tag${index}`),
      'Has spaces',
      'x'.repeat(25),
    ]
    for (const name of names) {
      const created = await tags.mutateLocalTag({ type: 'create', name })
      const id = created.find((tag) => tag.name === name)?.id ?? ''
      await tags.mutateLocalTag({ type: 'assign', id, templateId: 'local-art', attached: true })
      await tags.mutateLocalTag({ type: 'assign', id, templateId: 'hq', attached: true })
    }
    await personal.synchronizePersonalTemplates()
    const nativeId = (await read()).native?.id ?? ''
    expect(api.metadata.getById(nativeId)?.tags).toEqual(names.slice(0, 8))
    expect(tags.localTemplateTags('local-art').map((tag) => tag.name)).toEqual(names)
    expect(tags.localTemplateTags('hq').map((tag) => tag.name)).toEqual(names)
    expect(api.ids()).toHaveLength(1)
    const current = api.metadata.getById(nativeId)
    if (current === undefined) throw new Error('Missing native template')
    api.metadata.update(nativeId, {
      tags: current.tags?.slice(1) ?? [],
      tagColorIdxs: current.tagColorIdxs?.slice(1) ?? [],
    })
    await personal.synchronizePersonalTemplates()
    expect(tags.localTemplateTags('local-art').map((tag) => tag.name)).toEqual(names.slice(1))
    expect(api.metadata.getById(nativeId)?.tags).toEqual(names.slice(1, 9))
    expect(tags.localTemplateTags('hq').map((tag) => tag.name)).toEqual(names)
  })

  it('retries durable local tag edits after native persistence fails without resurrecting removed tags', async () => {
    const { seed, api, personal, metadata } = await fixture()
    const tags = await import('./tags.js')
    const linked = await seed()
    const id = linked.native?.id ?? ''
    metadata.update(id, { tags: ['Before'], tagColorIdxs: [19] })
    await personal.synchronizePersonalTemplates()
    const tag = tags.localTemplateTags(linked.id)[0]
    vi.mocked(metadata.commitPendingChanges).mockImplementationOnce(() => {
      throw new Error('quota')
    })
    await tags.mutateLocalTag({ type: 'rename', id: tag?.id ?? '', name: 'After' })
    await personal.synchronizePersonalTemplates()
    expect(api.metadata.getById(id)?.tags).toEqual(['After'])
    expect(tags.localTemplateTags(linked.id).map((tag) => tag.name)).toEqual(['After'])
    expect(metadata.commitPendingChanges).toHaveBeenCalledTimes(3)
  })

  it('keeps new tags local when the native catalog is full and mirrors them once space is available', async () => {
    const { seed, metadata, personal } = await fixture()
    const tags = await import('./tags.js')
    const linked = await seed()
    const catalog = Array.from({ length: 64 }, (_, index) => ({
      name: `Existing${index}`,
      colorIdx: 19,
    }))
    const catalogRead = vi.spyOn(metadata, 'tagCatalog', 'get').mockReturnValue(catalog)
    for (const name of ['Extra', 'Existing0']) {
      const created = await tags.mutateLocalTag({ type: 'create', name })
      await tags.mutateLocalTag({
        type: 'assign',
        id: created.find((tag) => tag.name === name)?.id ?? '',
        templateId: linked.id,
        attached: true,
      })
    }
    expect(metadata.getById(linked.native?.id ?? '')?.tags).toEqual(['Existing0'])
    expect(tags.localTemplateTags(linked.id).map((tag) => tag.name)).toEqual(['Extra', 'Existing0'])
    catalogRead.mockReturnValue(catalog.slice(0, 63))
    await personal.synchronizePersonalTemplates()
    expect(metadata.getById(linked.native?.id ?? '')?.tags).toEqual(['Existing0', 'Extra'])
  })

  it('migrates without changing local identity, artwork, placement, or Caelestis metadata', async () => {
    const { seed, read, api, personal } = await fixture()
    const migrated = await seed()
    expect(migrated).toMatchObject({
      ...local(),
      revision: 3,
      native: { status: 'linked' },
    })
    expect(api.ids()).toHaveLength(1)
    await personal.synchronizePersonalTemplates()
    expect(await read()).toEqual(migrated)
    expect(api.ids()).toHaveLength(1)
  })

  it('resumes migration after a native image write fails without duplicating artwork', async () => {
    const { images, personal, seed, read, api } = await fixture()
    vi.mocked(images.save).mockRejectedValueOnce(new Error('quota'))
    const pending = await seed()
    expect(pending.native?.status).toBe('pending')
    expect(pending.indices).toEqual(local().indices)
    await personal.synchronizePersonalTemplates()
    expect((await read()).native?.id).toBe(pending.native?.id)
    expect((await read()).native?.status).toBe('linked')
    expect(api.ids()).toHaveLength(1)
  })

  it('resumes after native creation but before the derived cache commits', async () => {
    const { seed, disk, personal, read, api } = await fixture()
    const linked = await seed()
    const id = linked.native?.id
    if (!id) throw new Error('missing ID')
    await disk.saveTemplate({ ...linked, native: { id, status: 'pending' } }, linked.revision)
    await personal.synchronizePersonalTemplates()
    expect((await read()).native?.status).toBe('linked')
    expect(api.ids()).toEqual([id])
  })

  it('mirrors native creates and edits into one stable local record', async () => {
    const { api, adapter, personal, read, metadata } = await fixture()
    await api.save(
      'native-art',
      {
        ...adapter.nativeMetadata(local()),
        originalWidth: 2,
        originalHeight: 2,
      },
      null,
      await adapter.nativeImage(local()),
    )
    await personal.synchronizePersonalTemplates()
    const id = await adapter.nativeLocalId('native-art')
    const before = await read(id)
    metadata.update('native-art', {
      ...adapter.nativeMetadata(local({ originX: 150 })),
      name: 'Renamed natively',
    })
    await personal.synchronizePersonalTemplates()
    expect(await read(id)).toMatchObject({
      id,
      originX: 150,
      name: 'Renamed natively',
      revision: before.revision + 1,
    })
  })

  it('keeps a failed migration projection under its original identity until rendering recovers', async () => {
    const { images, seed, disk, personal, api, read } = await fixture()
    const render = vi.spyOn(images, 'render').mockRejectedValueOnce(new Error('worker unavailable'))
    const pending = await seed()
    expect(pending.native?.status).toBe('pending')
    expect(api.ids()).toHaveLength(1)
    expect(await disk.loadTemplates()).toHaveLength(1)
    render.mockRestore()
    await personal.synchronizePersonalTemplates()
    expect((await read()).native?.status).toBe('linked')
    expect(await disk.loadTemplates()).toHaveLength(1)
    expect(api.ids()).toHaveLength(1)
  })

  it('applies Caelestis moves through the native store without rewriting source artwork', async () => {
    const { seed, personal, read, api, images } = await fixture()
    const template = await seed()
    const saved = await personal.saveTemplate({ ...template, originX: 300 }, template.revision)
    expect(saved.status).toBe('saved')
    expect((await read()).originX).toBe(300)
    expect((await api.read(template.native?.id ?? ''))?.template.bounds).not.toEqual(local())
    expect(images.save).toHaveBeenCalledTimes(1)
  })

  it('lets native edits win over stale local changes', async () => {
    const { seed, personal, metadata, read } = await fixture()
    const before = await seed()
    metadata.update(before.native?.id ?? '', { name: 'Native wins' })
    expect(
      await personal.saveTemplate({ ...before, name: 'Stale local' }, before.revision),
    ).toEqual({ status: 'conflict' })
    expect((await read()).name).toBe('Native wins')
  })

  it('does not restore deleted native templates from their old cache', async () => {
    const { seed, personal, api, disk } = await fixture()
    const before = await seed()
    const snapshot = await api.read(before.native?.id ?? '')
    if (!snapshot) throw new Error('missing native snapshot')
    await api.remove(snapshot)
    await personal.synchronizePersonalTemplates()
    expect(await disk.loadTemplate(before.id)).toEqual({ status: 'missing' })
    await personal.synchronizePersonalTemplates()
    expect(api.ids()).toEqual([])
  })

  it('retains artwork and metadata when the native image is temporarily unavailable', async () => {
    const { seed, personal, blobs, read } = await fixture()
    const before = await seed()
    blobs.clear()
    await personal.synchronizePersonalTemplates()
    expect(await read()).toEqual(before)
    expect(await personal.saveTemplate({ ...before, name: 'Edit' }, before.revision)).toEqual({
      status: 'unavailable',
    })
  })

  it('archives old artwork before publishing a local replacement to Wplace', async () => {
    const { seed, personal, read, disk } = await fixture()
    const before = await seed()
    const indices = new Uint8Array([5, 0, 10, TRANSPARENT_INDEX])
    expect(
      (await personal.saveTemplate({ ...before, indices }, before.revision, true)).status,
    ).toBe('saved')
    expect((await read()).indices).toEqual(indices)
    const db = await disk.openTemplateDatabase()
    const archived = await new Promise<unknown>((resolve) => {
      const request = db
        .transaction('local-template-versions')
        .objectStore('local-template-versions')
        .get([before.id, before.revision])
      request.onsuccess = () => resolve(request.result)
    })
    db.close()
    expect(archived).toMatchObject({ id: before.id, revision: before.revision })
  })

  it('keeps alliance templates in Caelestis storage without creating native personal copies', async () => {
    const { personal, api, disk } = await fixture()
    for (const kind of ['alliance-headquarters', 'alliance-picture', 'alliance-banner'] as const) {
      const template = local({
        id: kind,
        originX: kind === 'alliance-headquarters' ? -1 : 0,
        originY: 0,
        surface: { kind, allianceId: 42 },
      })
      expect((await personal.saveTemplate(template, null)).status).toBe('saved')
      expect((await disk.loadTemplate(kind)).status).toBe('loaded')
    }
    await personal.synchronizePersonalTemplates()
    expect(api.ids()).toEqual([])
  })

  it('does not delete a linked owner when the initial durable read is unavailable', async () => {
    const { seed, personal, disk, api } = await fixture()
    const before = await seed()
    vi.spyOn(disk, 'loadTemplate').mockResolvedValueOnce({ status: 'unavailable' })
    expect(await personal.deleteTemplate(before.id, before.revision)).toEqual({
      status: 'unavailable',
    })
    expect((await disk.loadTemplate(before.id)).status).toBe('loaded')
    expect(api.ids()).toHaveLength(1)
  })

  it('preserves inherited opacity during migration and after global changes', async () => {
    const { seed, api } = await fixture()
    const state = await import('../state.js')
    const { DEFAULT_APPEARANCE } = await import('./appearance.js')
    state.setState({ appearance: { ...DEFAULT_APPEARANCE, opacity: 0.2 } })
    const migrated = await seed()
    expect((await api.read(migrated.native?.id ?? ''))?.template.opacity).toBe(0.2)
    const store = await import('./local-store.js')
    await store.restoreLocalTemplates()
    const row = store.templateById(migrated.id)
    if (!row) throw new Error('Missing migrated template')
    state.setState({ appearance: { ...DEFAULT_APPEARANCE, opacity: 0.7 } })
    expect(store.appearanceOf(row).opacity).toBe(0.7)
  })

  it('keeps global shape inheritance when native opacity changes', async () => {
    const { seed, api, personal, read } = await fixture()
    const state = await import('../state.js')
    const { DEFAULT_APPEARANCE } = await import('./appearance.js')
    const migrated = await seed()
    const snapshot = await api.read(migrated.native?.id ?? '')
    if (!snapshot) throw new Error('Missing native template')
    await api.save(snapshot.template.id, { opacity: 0.25 }, snapshot)
    await personal.synchronizePersonalTemplates()
    const store = await import('./local-store.js')
    await store.restoreLocalTemplates()
    const row = store.templateById(migrated.id)
    if (!row) throw new Error('Missing local template')
    state.setState({ appearance: { ...DEFAULT_APPEARANCE, size: 1.5 } })
    expect(store.appearanceOf(row)).toMatchObject({ opacity: 0.25, size: 1.5 })
    expect((await read()).owns).toEqual(migrated.owns)
  })

  it('retains signed alliance copies after reload and commits their placed state once', async () => {
    const { disk } = await fixture()
    const store = await import('./local-store.js')
    const { copyNativeAllianceTemplate, NATIVE_ALLIANCE_OWNER } = await import(
      './native-alliance.js'
    )
    const surface = { kind: 'alliance-headquarters', allianceId: 42 } as const
    const source = {
      ...local(),
      id: `srv:${encodeURIComponent(NATIVE_ALLIANCE_OWNER)}:source`,
      originX: -10,
      originY: -20,
      surface,
      sourceOpacity: 0.25,
      serverUrl: NATIVE_ALLIANCE_OWNER,
      serverTemplateId: 'source',
      serverNodeId: null,
      serverVersion: '1',
    }
    await store.putServerTemplate(source)
    const native = store.templateById(source.id)
    if (!native) throw new Error('Missing native row')
    expect(store.appearanceOf(native).opacity).toBe(0.25)
    const save = vi.spyOn(disk, 'saveTemplate')
    await copyNativeAllianceTemplate(source.id)
    expect(save).toHaveBeenCalledTimes(1)
    const copied = store.localTemplates().find((row) => row.serverUrl === undefined)
    if (!copied) throw new Error('Missing copy')
    vi.resetModules()
    const restored = await import('./local-store.js')
    await restored.restoreLocalTemplates()
    expect(restored.templateById(copied.id)).toMatchObject({
      originX: -10,
      originY: -20,
      everPlaced: true,
      surface,
    })
  })

  it('preserves native opacity when taking ownership of marker controls', async () => {
    const { seed, api, personal, read } = await fixture()
    const migrated = await seed(local({ owns: [], appearance: null }))
    const snapshot = await api.read(migrated.native?.id ?? '')
    if (!snapshot) throw new Error('Missing native template')
    await api.save(snapshot.template.id, { opacity: 0.25 }, snapshot)
    await personal.synchronizePersonalTemplates()
    const store = await import('./local-store.js')
    await store.restoreLocalTemplates()
    expect(await store.setOwnsGroup(migrated.id, 'markers', true)).toBe(true)
    expect((await api.read(snapshot.template.id))?.template.opacity).toBe(0.25)
    expect((await read()).native?.opacityOverride).toBe(true)
  })

  it('does not expose a local alliance copy when its initial persistence fails', async () => {
    const { disk } = await fixture()
    const store = await import('./local-store.js')
    const { copyNativeAllianceTemplate, NATIVE_ALLIANCE_OWNER } = await import(
      './native-alliance.js'
    )
    const id = `srv:${encodeURIComponent(NATIVE_ALLIANCE_OWNER)}:source`
    await store.putServerTemplate({
      ...local(),
      id,
      surface: { kind: 'alliance-headquarters', allianceId: 42 },
      serverUrl: NATIVE_ALLIANCE_OWNER,
      serverTemplateId: 'source',
      serverNodeId: null,
      serverVersion: '1',
    })
    vi.spyOn(disk, 'saveTemplate').mockResolvedValueOnce({ status: 'unavailable' })
    await expect(copyNativeAllianceTemplate(id)).rejects.toThrow('could not be saved')
    expect(store.localTemplates().map((row) => row.id)).toEqual([id])
    expect(await disk.loadTemplates()).toEqual([])
  })

  it('leaves native artwork intact when its archive cannot reserve space', async () => {
    const { seed, personal, disk, images, api } = await fixture()
    const before = await seed()
    const snapshot = await api.read(before.native?.id ?? '')
    vi.spyOn(disk, 'saveTemplate').mockResolvedValueOnce({ status: 'limit' })
    expect(
      await personal.saveTemplate({ ...before, indices: new Uint8Array(4) }, before.revision, true),
    ).toEqual({ status: 'limit' })
    expect(images.save).toHaveBeenCalledTimes(1)
    expect((await api.read(before.native?.id ?? ''))?.token).toBe(snapshot?.token)
  })
})
