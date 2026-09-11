import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { warn } from '../debug.js'
import { getSurfaceAppearance } from '../state.js'
import { APPEARANCE_GROUPS } from './appearance.js'
import {
  NativeConflict,
  type NativeSnapshot,
  type NativeTemplates,
  nativeImage,
  nativeLocalId,
  nativeMetadata,
} from './native-store.js'
import type { SaveResult, StoredTemplate } from './persist.js'
import * as disk from './persist.js'

export type {
  SaveResult,
  StoredTemplate,
  TemplateLoadBatch,
  TemplateLoadFailure,
} from './persist.js'
export { deleteTemplate as discardTemplate, saveTemplateFolders } from './persist.js'

let native: NativeTemplates | null = null
let onMutation: (() => void) | undefined
let tail: Promise<unknown> = Promise.resolve()

// Serialize Caelestis mutations across tabs. Wplace remains authoritative and is checked before writes.
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const run = async () =>
    typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request('caelestis-personal-templates', operation)
      : await operation()
  const pending = tail.then(run, run)
  tail = pending.catch(() => {})
  return pending
}

const isWorld = (template: StoredTemplate): boolean =>
  (template.surface ?? WORLD_TEMPLATE_SURFACE).kind === 'world'

const loadedTemplate = (loaded: disk.LoadTemplateResult): StoredTemplate | null =>
  loaded.status === 'loaded' ? (loaded.template as StoredTemplate) : null

const cacheResult = (result: SaveResult): number => {
  if (result.status === 'saved') return result.revision
  if (result.status === 'conflict') throw new NativeConflict()
  throw new Error(`Could not retain the Wplace template cache (${result.status})`)
}

const samePixels = (a: StoredTemplate, b: StoredTemplate): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.indices.length === b.indices.length &&
  a.indices.every((value, index) => value === b.indices[index])

const project = async (
  api: NativeTemplates,
  snapshot: NativeSnapshot,
  previous: StoredTemplate | null,
): Promise<StoredTemplate> => {
  if (previous?.native?.token === snapshot.token) return previous
  const pixels = await api.pixels(snapshot)
  const nativeOpacityChanged =
    previous === null ||
    (previous.native?.status === 'linked' && previous.native.opacity !== snapshot.template.opacity)
  const owns = previous?.owns ?? (previous?.appearance != null ? APPEARANCE_GROUPS : [])
  const template: StoredTemplate = {
    ...previous,
    ...pixels,
    id: previous?.id ?? pixels.id,
    // An existing import keeps its source attribution and quantization report.
    source: previous?.source ?? pixels.source,
    moved: Math.min(previous?.moved ?? pixels.moved, pixels.opaque),
    revision: previous?.revision ?? 0,
    visible: snapshot.template.visible,
    everPlaced: snapshot.template.hasPlaced,
    updatedAt: snapshot.template.updatedAt,
    surface: WORLD_TEMPLATE_SURFACE,
    appearance: nativeOpacityChanged
      ? {
          ...(previous?.appearance ?? getSurfaceAppearance(WORLD_TEMPLATE_SURFACE)),
          opacity: snapshot.template.opacity,
        }
      : (previous?.appearance ?? null),
    owns: nativeOpacityChanged ? [...new Set([...owns, 'pixels' as const])] : owns,
    folderId: previous?.folderId ?? null,
    native: {
      id: snapshot.template.id,
      status: 'linked',
      token: snapshot.token,
      opacity: snapshot.template.opacity,
    },
  }
  const artworkChanged = previous !== null && !samePixels(previous, template)
  // A native edit during decoding supersedes this projection.
  if ((await api.read(snapshot.template.id))?.token !== snapshot.token) throw new NativeConflict()
  const revision = cacheResult(
    await disk.saveTemplate(template, previous?.revision ?? null, artworkChanged),
  )
  return { ...template, revision }
}

/** Journal the native identity before copying pixels, so an interrupted migration never duplicates art. */
const migrate = async (api: NativeTemplates, template: StoredTemplate): Promise<StoredTemplate> => {
  if (!isWorld(template) || template.native?.status === 'linked') return template
  let pending = template
  if (pending.native === undefined) {
    const id = `caelestis-${await nativeLocalId(template.id)}`
    // A pre-existing record under our migration identity is never overwritten.
    if (api.metadata.getById(id) !== undefined) throw new NativeConflict()
    pending = { ...template, native: { id, status: 'pending' } }
    pending = {
      ...pending,
      revision: cacheResult(await disk.saveTemplate(pending, template.revision)),
    }
  }
  const id = pending.native?.id
  if (id === undefined) throw new Error('Migration identity is missing')
  const existing = await api.read(id)
  const snapshot =
    existing ??
    (await api.save(
      id,
      {
        ...nativeMetadata(pending),
        originalWidth: pending.width,
        originalHeight: pending.height,
        opacity:
          (pending.owns?.includes('pixels') ?? pending.appearance != null)
            ? (pending.appearance?.opacity ?? getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity)
            : getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity,
      },
      null,
      await nativeImage(pending),
    ))
  return await project(api, snapshot, pending)
}

const synchronizeOne = async (
  api: NativeTemplates,
  template: StoredTemplate,
): Promise<StoredTemplate | null> => {
  if (!isWorld(template)) return template
  if (template.native?.status !== 'linked') return await migrate(api, template)
  const snapshot = await api.read(template.native.id)
  if (snapshot !== null) return await project(api, snapshot, template)
  // Native absence is authoritative after migration commits. Never re-create a deleted native ID.
  cacheResult(await disk.deleteTemplate(template.id, template.revision))
  return null
}

/** Install the native owner. Alliance records continue through Caelestis's existing surface wrapper. */
export const connectPersonalStore = (api: NativeTemplates, observer?: () => void): void => {
  native = api
  onMutation = observer
}

/** Refresh derived records, preserving individual failures for retry rather than treating them as deletions. */
export const synchronizePersonalTemplates = (): Promise<void> =>
  exclusive(async () => {
    if (native === null) return
    const api = native
    const rows = await disk.loadTemplates()
    const known = new Map<string, StoredTemplate>()
    for (const value of rows) {
      if (typeof value !== 'object' || value === null || !('indices' in value)) continue
      const template = value as StoredTemplate
      if (!isWorld(template)) continue
      if (template.native !== undefined) known.set(template.native.id, template)
      try {
        const current = await synchronizeOne(api, template)
        if (current?.native !== undefined) known.set(current.native.id, current)
      } catch (error) {
        warn('install', `could not sync personal template ${template.name}`, String(error))
      }
    }
    const identities = await disk.loadNativeTemplateIds()
    for (const id of api.ids()) {
      if (known.has(id)) continue
      try {
        const snapshot = await api.read(id)
        if (snapshot === null) continue
        // A previous pass may have left a projection outside this batch's hydration budget.
        const localId = identities.get(id) ?? (await nativeLocalId(id))
        const loaded = await disk.loadTemplate(localId)
        if (loaded.status !== 'loaded' && loaded.status !== 'missing') continue
        const previous = loadedTemplate(loaded)
        // A pending migration retains its original identity even when decoding failed earlier in this pass.
        if (previous?.native?.status === 'pending') continue
        await project(api, snapshot, previous)
      } catch (error) {
        warn('install', `could not mirror Wplace template ${id}`, String(error))
      }
    }
  })

/** Read the native winner for linked records; legacy/alliance records keep their existing persistence contract. */
export const loadTemplate = async (
  id: string,
  maxIndexPixels?: number,
): Promise<disk.LoadTemplateResult> => {
  if (native === null) return await disk.loadTemplate(id, maxIndexPixels)
  return await exclusive(async () => {
    const loaded = await disk.loadTemplate(id, maxIndexPixels)
    const previous = loadedTemplate(loaded)
    if (previous?.native === undefined || native === null) return loaded
    try {
      const current = await synchronizeOne(native, previous)
      return current === null ? { status: 'missing' } : { status: 'loaded', template: current }
    } catch (error) {
      warn('install', `could not read native template ${id}`, String(error))
      return { status: 'unavailable' }
    }
  })
}

export const loadTemplates = disk.loadTemplates

/** Commit supported personal edits through Wplace, then retain the derived pixels and Caelestis metadata. */
export const saveTemplate = async (
  template: StoredTemplate,
  expectedRevision: number | null,
  archiveCurrent = false,
): Promise<SaveResult> => {
  if (!isWorld(template) || (native === null && template.native === undefined))
    return archiveCurrent
      ? await disk.saveTemplate(template, expectedRevision, true)
      : await disk.saveTemplate(template, expectedRevision)
  if (native === null) return { status: 'unavailable' }
  return await exclusive<SaveResult>(async () => {
    const api = native
    if (api === null) return { status: 'unavailable' }
    try {
      const previous = loadedTemplate(await disk.loadTemplate(template.id))
      if (
        previous?.revision !== expectedRevision &&
        !(previous === null && expectedRevision === null)
      )
        return { status: 'conflict' }
      if (previous === null) {
        const saved = await disk.saveTemplate(template, null)
        if (saved.status !== 'saved') return saved
        const linked = await migrate(api, { ...template, revision: saved.revision })
        return { status: 'saved', revision: linked.revision }
      }
      let linked = await migrate(api, previous)
      const nativeId = linked.native?.id
      if (nativeId === undefined) throw new Error('Native identity is missing')
      const snapshot = await api.read(nativeId)
      if (snapshot === null || snapshot.token !== linked.native?.token) {
        await synchronizeOne(api, linked)
        return { status: 'conflict' }
      }
      const patch = nativeMetadata(template)
      const opacityChanged =
        template.appearance?.opacity !== previous.appearance?.opacity ||
        template.owns?.includes('pixels') !== previous.owns?.includes('pixels')
      const opacity = opacityChanged
        ? template.owns?.includes('pixels') && template.appearance != null
          ? template.appearance.opacity
          : getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity
        : snapshot.template.opacity
      const changed =
        JSON.stringify(patch) !== JSON.stringify(nativeMetadata(linked)) ||
        opacity !== snapshot.template.opacity
      if (archiveCurrent) {
        // Reserve history before changing native artwork. A full archive must leave native pixels intact.
        const archived = await disk.saveTemplate(linked, linked.revision, true)
        if (archived.status !== 'saved') return archived
        linked = { ...linked, revision: archived.revision }
      }
      const saved =
        changed || archiveCurrent
          ? await api.save(
              nativeId,
              {
                ...patch,
                opacity,
                ...(archiveCurrent
                  ? {
                      originalWidth: template.width,
                      originalHeight: template.height,
                      colorMetric: 'lab',
                      dithering: false,
                      useLegacyColors: false,
                      colorPaletteMode: 'all',
                      templateColorIdxs: undefined,
                    }
                  : {}),
              },
              snapshot,
              archiveCurrent ? await nativeImage(template) : undefined,
            )
          : snapshot
      const next: StoredTemplate = {
        ...template,
        native: {
          id: nativeId,
          status: 'linked',
          token: saved.token,
          opacity: saved.template.opacity,
        },
      }
      // A native write may finish even if this derived cache cannot. Reconciliation reads the native winner.
      const result = await disk.saveTemplate(next, linked.revision, false, archiveCurrent)
      return result.status === 'saved' ? result : { status: 'conflict' }
    } catch (error) {
      warn('install', `could not save personal template ${template.name}`, String(error))
      return { status: error instanceof NativeConflict ? 'conflict' : 'unavailable' }
    }
  }).finally(() => onMutation?.())
}

/** Native deletion wins; server-owned templates never reach this local persistence boundary. */
export const deleteTemplate = async (id: IDBValidKey, revision: number): Promise<SaveResult> => {
  const loaded = typeof id === 'string' ? await disk.loadTemplate(id) : null
  if (loaded?.status === 'unavailable' || loaded?.status === 'invalid')
    return { status: 'unavailable' }
  const previous = loaded === null ? null : loadedTemplate(loaded)
  if (previous?.native === undefined) return await disk.deleteTemplate(id, revision)
  if (native === null) return { status: 'unavailable' }
  return await exclusive(async () => {
    const current = typeof id === 'string' ? loadedTemplate(await disk.loadTemplate(id)) : null
    if (current?.revision !== revision || current.native === undefined || native === null)
      return { status: 'conflict' }
    try {
      const snapshot = await native.read(current.native.id)
      if (snapshot !== null) {
        if (snapshot.token !== current.native.token) return { status: 'conflict' }
        await native.remove(snapshot)
      }
      return await disk.deleteTemplate(id, revision)
    } catch (error) {
      warn('install', `could not delete native template ${String(id)}`, String(error))
      return { status: error instanceof NativeConflict ? 'conflict' : 'unavailable' }
    }
  })
}
