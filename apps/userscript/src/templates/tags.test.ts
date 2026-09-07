import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const seedLegacy = async () => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('caelestis', 4)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('local-templates', { keyPath: 'id' })
      request.result.createObjectStore('server-cache', { keyPath: 'url' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction('local-templates', 'readwrite')
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
  it.each(['local', 'cache'])(
    'upgrades through the %s entry point without losing templates or tags',
    async (entry) => {
      await seedLegacy()
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
