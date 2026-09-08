import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const seedLegacy = async (version = 4) => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('caelestis', version)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('local-templates', { keyPath: 'id' })
      request.result.createObjectStore('server-cache', { keyPath: 'url' })
      if (version === 5)
        request.result.createObjectStore('local-template-versions', { keyPath: ['id', 'revision'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction(
    version === 5 ? ['local-templates', 'local-template-versions'] : ['local-templates'],
    'readwrite',
  )
  if (version === 5)
    transaction
      .objectStore('local-template-versions')
      .put({ id: 'first', revision: 0, marker: 'archive' })
  for (const id of ['first', 'second'])
    transaction.objectStore('local-templates').put({
      id,
      name: id,
      source: 'image',
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      indices: new Uint8Array([0]),
      moved: 0,
      opaque: 1,
      revision: 0,
      visible: true,
      everPlaced: true,
      paletteMigration: 4,
    })
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

describe('local tags in IndexedDB', () => {
  it('shares tags with folders, reloads assignments, and removes deleted folder references', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
    await seedLegacy()
    const { createLocalFolder, removeLocalFolder } = await import('../local-folders.js')
    const folder = createLocalFolder(null, 'Folder')
    expect(folder).not.toBeNull()
    const folderId = folder?.id ?? ''
    const tags = await import('./tags.js')
    const id = (await tags.mutateLocalTag({ type: 'create', name: 'Repair' }))[0]?.id ?? ''
    await tags.mutateLocalTag({ type: 'assign', id, templateId: 'first', attached: true })
    await tags.mutateLocalTag({ type: 'assign-folder', id, folderId, attached: true })
    await tags.mutateLocalTag({ type: 'rename', id, name: 'Priority' })
    expect(await tags.readLocalTags()).toEqual([
      { id, name: 'Priority', templateIds: ['first'], folderIds: [folderId] },
    ])
    expect(tags.localFolderTags(folderId)).toMatchObject([{ id, name: 'Priority' }])
    await tags.mutateLocalTag({ type: 'assign-folder', id, folderId, attached: false })
    expect(tags.localFolderTags(folderId)).toEqual([])
    await tags.mutateLocalTag({ type: 'assign-folder', id, folderId, attached: true })
    expect(removeLocalFolder(folderId)).toBe(true)
    expect(await tags.readLocalTags()).toEqual([
      { id, name: 'Priority', templateIds: ['first'], folderIds: [] },
    ])
    await expect(
      tags.mutateLocalTag({ type: 'assign-folder', id, folderId, attached: true }),
    ).rejects.toThrow('no longer exists')
    await tags.mutateLocalTag({ type: 'delete', id })
    expect(await tags.readLocalTags()).toEqual([])
  })
  it.each([
    ['local', 4],
    ['cache', 4],
    ['local', 5],
    ['cache', 5],
  ] as const)(
    'upgrades through the %s entry point from v%s without losing templates, history, or tags',
    async (entry, version) => {
      await seedLegacy(version)
      if (entry === 'cache') await (await import('../server-cache.js')).loadServerCache([])
      let tags = await import('./tags.js')
      expect(await tags.readLocalTags()).toEqual([])
      const created = await tags.mutateLocalTag({ type: 'create', name: 'Repair' })
      const id = created[0]?.id ?? ''
      for (const templateId of ['first', 'second'])
        await tags.mutateLocalTag({ type: 'assign', id, templateId, attached: true })
      await tags.mutateLocalTag({ type: 'rename', id, name: 'Priority' })
      vi.resetModules()
      tags = await import('./tags.js')
      expect(await tags.readLocalTags()).toEqual([
        { id, name: 'Priority', templateIds: ['first', 'second'] },
      ])
      const { loadTemplates } = await import('./persist.js')
      expect(await loadTemplates()).toHaveLength(2)
      if (version === 5) {
        const { openTemplateDatabase } = await import('./persist.js')
        const database = await openTemplateDatabase()
        expect(database.version).toBe(6)
        const history = await new Promise<unknown>((resolve, reject) => {
          const request = database
            .transaction('local-template-versions')
            .objectStore('local-template-versions')
            .get(['first', 0])
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        database.close()
        expect(history).toEqual({ id: 'first', revision: 0, marker: 'archive' })
      }
      await tags.mutateLocalTag({ type: 'delete', id })
      expect(await tags.readLocalTags()).toEqual([])
      expect(await loadTemplates()).toHaveLength(2)
    },
  )

  it('serializes concurrent duplicate creation and rolls back conflicting renames', async () => {
    await seedLegacy()
    const tags = await import('./tags.js')
    const results = await Promise.allSettled([
      tags.mutateLocalTag({ type: 'create', name: 'Repair' }),
      tags.mutateLocalTag({ type: 'create', name: 'REPAIR' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const created = await tags.mutateLocalTag({ type: 'create', name: 'Other' })
    const id = created.find((tag) => tag.name === 'Other')?.id ?? ''
    await tags.mutateLocalTag({ type: 'assign', id, templateId: 'first', attached: true })
    await expect(tags.mutateLocalTag({ type: 'rename', id, name: 'repair' })).rejects.toThrow(
      'already exists',
    )
    expect(await tags.readLocalTags()).toContainEqual({ id, name: 'Other', templateIds: ['first'] })
    await expect(tags.mutateLocalTag({ type: 'create', name: ' ' })).rejects.toThrow('1–64')
  })

  it('detaches explicitly and removes assignments atomically when a template is deleted', async () => {
    await seedLegacy()
    const tags = await import('./tags.js')
    const id = (await tags.mutateLocalTag({ type: 'create', name: 'Repair' }))[0]?.id ?? ''
    await tags.mutateLocalTag({ type: 'assign', id, templateId: 'first', attached: true })
    await tags.mutateLocalTag({ type: 'assign', id, templateId: 'first', attached: false })
    expect((await tags.readLocalTags())[0]?.templateIds).toEqual([])
    await tags.mutateLocalTag({ type: 'assign', id, templateId: 'second', attached: true })
    const { deleteTemplate } = await import('./persist.js')
    expect(await deleteTemplate('second', 0)).toMatchObject({ status: 'saved' })
    expect((await tags.readLocalTags())[0]?.templateIds).toEqual([])
    await expect(
      tags.mutateLocalTag({ type: 'assign', id, templateId: 'second', attached: true }),
    ).rejects.toThrow('no longer exists')
  })

  it('reports storage failures and permits a fresh read after recovery', async () => {
    const tags = await import('./tags.js')
    const factory = indexedDB
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('Offline storage unavailable')
      },
    })
    await expect(tags.readLocalTags()).rejects.toThrow('storage unavailable')
    vi.stubGlobal('indexedDB', factory)
    expect(await tags.readLocalTags()).toEqual([])
  })
})
