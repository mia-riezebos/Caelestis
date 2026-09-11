import { canvasPixelToLatLng, TRANSPARENT_INDEX, WORLD_PIXELS } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeConflict,
  type NativeImageStore,
  type NativeMetadataStore,
  type NativeTemplate,
  NativeTemplates,
  nativeImage,
  nativeLocalId,
  nativeMetadata,
  nativePlacement,
} from './native-store.js'

const local = {
  id: 'local-one',
  name: 'Artwork',
  source: 'wplace' as const,
  originX: 100,
  originY: 100,
  width: 2,
  height: 2,
  indices: new Uint8Array([0, 1, 2, TRANSPARENT_INDEX]),
  opaque: 3,
  moved: 0,
  visible: true,
  everPlaced: true,
}

const fixture = () => {
  const rows = new Map<string, NativeTemplate>()
  const blobs = new Map<string, Blob>()
  const listeners = new Set<() => void>()
  const metadata: NativeMetadataStore = {
    get templates() {
      return [...rows.values()]
    },
    placementSession: false,
    getById: (id) => rows.get(id),
    add: (row) => {
      rows.set(row.id, row)
    },
    update: (id, patch) => {
      const previous = rows.get(id)
      if (previous) rows.set(id, { ...previous, ...patch })
    },
    remove: (id) => {
      rows.delete(id)
    },
    persist: vi.fn(),
    commitPendingChanges: vi.fn(),
    subscribeChange: (listener) => {
      const call = () => listener({ kind: 'update', id: 'one' })
      listeners.add(call)
      return () => {
        listeners.delete(call)
      }
    },
  }
  const images: NativeImageStore = {
    read: vi.fn(async (id) => blobs.get(id)),
    save: vi.fn(async (id, blob) => {
      blobs.set(id, blob)
    }),
    remove: vi.fn(async (id) => {
      blobs.delete(id)
    }),
    render: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }
  const api = new NativeTemplates(metadata, images)
  const create = async () =>
    await api.save(
      'one',
      {
        ...nativeMetadata(local),
        originalWidth: 2,
        originalHeight: 2,
        locked: true,
      },
      null,
      await nativeImage(local),
    )
  return { api, metadata, images, rows, blobs, listeners, create }
}

describe('native personal templates', () => {
  it('round-trips placement at world edges', () => {
    for (const [x, y] of [
      [0, 0],
      [WORLD_PIXELS - 2, WORLD_PIXELS - 2],
      [1234567, 987654],
    ]) {
      const placement = { ...local, originX: x ?? 0, originY: y ?? 0 }
      expect(nativePlacement(nativeMetadata(placement) as NativeTemplate)).toEqual({
        originX: x,
        originY: y,
        width: 2,
        height: 2,
      })
    }
  })

  it('rejects unbounded or inverted native placements', () => {
    const nw = canvasPixelToLatLng({ x: 0, y: 0 })
    const se = canvasPixelToLatLng({ x: 10000, y: 10000 })
    expect(() =>
      nativePlacement({
        bounds: { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng },
      } as NativeTemplate),
    ).toThrow('too large')
    expect(() =>
      nativePlacement({ bounds: { north: 0, west: 1, south: 1, east: 0 } } as NativeTemplate),
    ).toThrow('bounds')
  })

  it('gives native IDs stable, bounded identities without conflating similar IDs', async () => {
    expect(await nativeLocalId('a')).toBe(await nativeLocalId('a'))
    expect(await nativeLocalId('a')).not.toBe(await nativeLocalId('A'))
    expect((await nativeLocalId('x'.repeat(1000))).length).toBeLessThan(128)
  })

  it('preserves native source bytes and settings for metadata-only edits', async () => {
    const { api, create, images, metadata } = fixture()
    const first = await create()
    const moved = await api.save('one', nativeMetadata({ ...local, originX: 400 }), first)
    expect(moved.template.locked).toBe(true)
    expect(nativePlacement(moved.template).originX).toBe(400)
    expect(await moved.image.arrayBuffer()).toEqual(await first.image.arrayBuffer())
    expect(images.save).toHaveBeenCalledTimes(1)
    expect(images.save).toHaveBeenCalledWith('one', expect.any(Blob), 'remote')
    expect(metadata.commitPendingChanges).toHaveBeenCalledTimes(2)
  })

  it('detects native artwork replacement even when metadata is unchanged', async () => {
    const { api, create, blobs, metadata } = fixture()
    const previous = await create()
    blobs.set('one', new Blob(['changed']))
    await expect(api.save('one', { name: 'stale' }, previous)).rejects.toBeInstanceOf(
      NativeConflict,
    )
    expect(metadata.getById('one')?.name).toBe('Artwork')
  })

  it('does not resurrect native deletions', async () => {
    const { api, create } = fixture()
    const previous = await create()
    await api.remove(previous)
    await expect(api.save('one', { name: 'stale' }, previous)).rejects.toBeInstanceOf(
      NativeConflict,
    )
    expect(await api.read('one')).toBeNull()
  })

  it('does not adopt or overwrite server-managed native templates', async () => {
    const { api, create, metadata, images } = fixture()
    await create()
    metadata.update('one', { serverManaged: true })
    expect(api.ids()).toEqual([])
    expect(await api.read('one')).toBeNull()
    await expect(api.save('one', { name: 'copy' }, null, new Blob())).rejects.toBeInstanceOf(
      NativeConflict,
    )
    expect(images.save).toHaveBeenCalledTimes(1)
  })

  it('reports missing artwork without removing native metadata', async () => {
    const { api, create, blobs, metadata } = fixture()
    await create()
    blobs.clear()
    await expect(api.read('one')).rejects.toThrow('unavailable')
    expect(metadata.templates).toHaveLength(1)
  })

  it('does not publish metadata when native image persistence fails', async () => {
    const { create, images, metadata } = fixture()
    vi.mocked(images.save).mockRejectedValue(new Error('quota'))
    await expect(create()).rejects.toThrow('quota')
    expect(metadata.templates).toEqual([])
  })

  it('observes native reordering and restores the original method on disposal', () => {
    const { api, metadata } = fixture()
    const original = metadata.persist
    const listener = vi.fn()
    const dispose = api.subscribe(listener)
    metadata.persist()
    expect(original).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
    dispose()
    expect(metadata.persist).toBe(original)
  })

  it('accepts this tab’s native persistence but refuses to overwrite newer metadata from another tab', async () => {
    const { create, metadata, images } = fixture()
    await create()
    let persisted = JSON.stringify(metadata.templates)
    const guarded = new NativeTemplates(metadata, images, undefined, () => persisted)
    metadata.update('one', { name: 'This tab' })
    persisted = JSON.stringify(metadata.templates)
    const snapshot = await guarded.read('one')
    expect(snapshot?.template.name).toBe('This tab')
    persisted = JSON.stringify(metadata.templates.map((row) => ({ ...row, name: 'Another tab' })))
    await expect(guarded.save('one', { name: 'Stale edit' }, snapshot)).rejects.toThrow(
      'another tab',
    )
    expect(metadata.getById('one')?.name).toBe('This tab')
    expect(images.save).toHaveBeenCalledTimes(1)
  })
})
