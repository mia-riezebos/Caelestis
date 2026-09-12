import {
  MAX_TEMPLATE_TAGS,
  parseTemplateTags,
  type TemplateTag,
  tagName,
  tagNameKey,
  uuidV7,
} from '@caelestis/shared'
import { leaseLocalFolder } from '../local-folders.js'
import { getState, MAX_LOCAL_FOLDERS } from '../state.js'
import type { NativeTemplates } from './native-store.js'
import { reconcileNativeTags } from './native-tags.js'
import type { StoredTemplate } from './persist.js'
import { openTemplateDatabase } from './persist.js'
import { LOCAL_TAG_STORE } from './tag-schema.js'

export interface LocalTag extends TemplateTag {
  readonly templateIds: readonly string[]
  readonly folderIds?: readonly string[]
}

export type LocalTagMutation =
  | { readonly type: 'create'; readonly name: string }
  | { readonly type: 'rename'; readonly id: string; readonly name: string }
  | { readonly type: 'delete'; readonly id: string }
  | {
      readonly type: 'assign-folder'
      readonly id: string
      readonly folderId: string
      readonly attached: boolean
    }
  | {
      readonly type: 'assign'
      readonly id: string
      readonly templateId: string
      readonly attached: boolean
    }

let snapshot: readonly LocalTag[] = []
let hydration: Promise<readonly LocalTag[]> | undefined
let synchronize: (() => Promise<void>) | undefined
const listeners = new Set<() => void>()

/** Follow native and local tag edits while a tag manager is open. */
export const onLocalTags = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const updateSnapshot = (tags: readonly LocalTag[]): void => {
  const changed = JSON.stringify(snapshot) !== JSON.stringify(tags)
  snapshot = tags
  if (changed) for (const listener of listeners) listener()
}

/** Schedule personal tag mirroring after a durable local edit. */
export const connectLocalTagSync = (sync: () => Promise<void>): void => {
  synchronize = sync
}

/** Catalog snapshot for filter choices after local tag hydration. */
export const localTagCatalog = (): readonly LocalTag[] => snapshot

/** Current labels for a tree row, after the catalog has loaded. */
export const localTemplateTags = (templateId: string): readonly TemplateTag[] =>
  snapshot.filter((tag) => tag.templateIds.includes(templateId))

/** Current labels assigned directly to a local folder. */
export const localFolderTags = (folderId: string): readonly TemplateTag[] =>
  snapshot.filter((tag) => tag.folderIds?.includes(folderId))

const parseStoredTags = (value: unknown): readonly LocalTag[] => {
  if (
    !Array.isArray(value) ||
    parseTemplateTags(value) === null ||
    value.some(
      (tag) =>
        !Array.isArray(tag.templateIds) ||
        tag.templateIds.length > 64 ||
        tag.templateIds.some((id: unknown) => typeof id !== 'string') ||
        (tag.folderIds !== undefined &&
          (!Array.isArray(tag.folderIds) ||
            tag.folderIds.length > MAX_LOCAL_FOLDERS ||
            tag.folderIds.some((id: unknown) => typeof id !== 'string'))),
    )
  ) {
    throw new Error('Stored tags could not be read.')
  }
  const folders = new Set(getState().localFolders.map((folder) => folder.id))
  return (value as readonly LocalTag[]).map((tag) =>
    tag.folderIds === undefined
      ? tag
      : { ...tag, folderIds: tag.folderIds.filter((id) => folders.has(id)) },
  )
}

/** Load authoritative local tags, including assignments from other tabs. */
export const readLocalTags = async (): Promise<readonly LocalTag[]> => {
  const database = await openTemplateDatabase()
  try {
    const tags = await new Promise<readonly LocalTag[]>((resolve, reject) => {
      const transaction = database.transaction(LOCAL_TAG_STORE, 'readonly')
      const request = transaction.objectStore(LOCAL_TAG_STORE).getAll()
      transaction.oncomplete = () => {
        try {
          resolve(parseStoredTags(request.result))
        } catch (error) {
          reject(error)
        }
      }
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Could not load local tags.'))
    })
    updateSnapshot(tags)
    return tags
  } finally {
    database.close()
  }
}

/** Hydrate tree search once; callers can retry a failed read through the editor. */
export const ensureLocalTags = (): Promise<readonly LocalTag[]> => (hydration ??= readLocalTags())

/** Serialize tag lifecycle and assignment checks in one IndexedDB transaction. */
const mutateStoredTag = async (mutation: LocalTagMutation): Promise<readonly LocalTag[]> => {
  const name = 'name' in mutation ? tagName(mutation.name) : undefined
  if (name === null) throw new Error('Use 1–64 characters without control characters.')
  const database = await openTemplateDatabase()
  const releaseFolder =
    mutation.type === 'assign-folder' ? leaseLocalFolder(mutation.folderId) : undefined
  try {
    if (releaseFolder === null) throw new Error('Folder no longer exists.')
    const tags = await new Promise<readonly LocalTag[]>((resolve, reject) => {
      const transaction = database.transaction([LOCAL_TAG_STORE, 'local-templates'], 'readwrite')
      const store = transaction.objectStore(LOCAL_TAG_STORE)
      const request = store.getAll()
      let failure: unknown
      let next: readonly LocalTag[] = []
      const fail = (error: unknown): void => {
        failure = error
        transaction.abort()
      }
      request.onsuccess = () => {
        try {
          const current = parseStoredTags(request.result)
          const existing =
            'id' in mutation ? current.find((tag) => tag.id === mutation.id) : undefined
          if (mutation.type !== 'create' && existing === undefined)
            throw new Error('Tag no longer exists. Reload and try again.')
          if (
            name !== undefined &&
            current.some(
              (tag) => tag.id !== existing?.id && tagNameKey(tag.name) === tagNameKey(name),
            )
          )
            throw new Error('A tag with that name already exists.')
          if (mutation.type === 'create' && current.length >= MAX_TEMPLATE_TAGS)
            throw new Error('The 256-tag limit was reached.')
          if (mutation.type === 'create') {
            const tag: LocalTag = { id: uuidV7(), name: name ?? '', templateIds: [] }
            store.add(tag)
            next = [...current, tag]
            return
          }
          if (existing === undefined) return
          if (mutation.type === 'delete') {
            store.delete(existing.id)
            next = current.filter((tag) => tag.id !== existing.id)
            return
          }
          const save = (tag: LocalTag): void => {
            store.put(tag)
            next = current.map((item) => (item.id === tag.id ? tag : item))
          }
          if (mutation.type === 'rename') {
            save({ ...existing, name: name ?? existing.name })
            return
          }
          if (mutation.type === 'assign-folder') {
            const folderIds = new Set(existing.folderIds ?? [])
            if (mutation.attached) folderIds.add(mutation.folderId)
            else folderIds.delete(mutation.folderId)
            save({ ...existing, folderIds: [...folderIds] })
            return
          }
          const template = transaction.objectStore('local-templates').get(mutation.templateId)
          template.onsuccess = () => {
            if (template.result === undefined) {
              fail(new Error('Template no longer exists.'))
              return
            }
            const templateIds = new Set(existing.templateIds)
            if (mutation.attached) templateIds.add(mutation.templateId)
            else templateIds.delete(mutation.templateId)
            save({ ...existing, templateIds: [...templateIds] })
          }
        } catch (error) {
          fail(error)
        }
      }
      transaction.oncomplete = () => resolve(next)
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('Could not save local tags.'))
    })
    updateSnapshot(tags)
    return tags
  } finally {
    releaseFolder?.()
    database.close()
  }
}

/** Save locally first so interrupted or unavailable native writes can be retried. */
export const mutateLocalTag = async (mutation: LocalTagMutation): Promise<readonly LocalTag[]> => {
  await mutateStoredTag(mutation)
  await synchronize?.()
  return snapshot
}

/** Commit assignments and their comparison baseline together, without rewriting artwork revisions. */
export const synchronizeLocalTemplateTags = async (
  templateId: string,
  native: NativeTemplates,
): Promise<boolean> => {
  const database = await openTemplateDatabase()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction([LOCAL_TAG_STORE, 'local-templates'], 'readwrite')
      const store = transaction.objectStore(LOCAL_TAG_STORE)
      const templates = transaction.objectStore('local-templates')
      const tagsRequest = store.getAll()
      const templateRequest = templates.get(templateId)
      let failure: unknown
      let next: readonly LocalTag[] | undefined
      let changed = false
      templateRequest.onsuccess = () => {
        try {
          const template = templateRequest.result as StoredTemplate | undefined
          if (template?.native === undefined || (template.surface?.kind ?? 'world') !== 'world')
            return
          const tags = parseStoredTags(tagsRequest.result)
          const baseline = parseTemplateTags(template.nativeTags ?? [])
          if (baseline === null) throw new Error('Stored tag mirror could not be read.')
          const retired = (native.metadata.tagCatalog ?? [])
            .filter(
              (entry) =>
                baseline.some((tag) => tagNameKey(tag.name) === tagNameKey(entry.name)) &&
                !tags.some((tag) => tagNameKey(tag.name) === tagNameKey(entry.name)) &&
                !native.metadata.templates.some(
                  (row) =>
                    row.id !== template.native?.id &&
                    row.tags?.some((name) => tagNameKey(name) === tagNameKey(entry.name)),
                ),
            )
            .map((tag) => tag.name)
          changed = native.reconcileTags(
            template.native.id,
            (current, catalog) => {
              const result = reconcileNativeTags(templateId, tags, baseline, current, catalog)
              next = result.local
              for (const tag of tags) {
                if (!next.some((remaining) => remaining.id === tag.id)) store.delete(tag.id)
              }
              for (const tag of next) {
                if (JSON.stringify(tag) !== JSON.stringify(tags.find((old) => old.id === tag.id)))
                  store.put(tag)
              }
              if (JSON.stringify(baseline) !== JSON.stringify(result.mirrored))
                templates.put({ ...template, nativeTags: result.mirrored })
              return {
                tags: result.names,
                tagColorIdxs: result.colours,
              }
            },
            retired,
          )
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      transaction.oncomplete = () => {
        if (next !== undefined) updateSnapshot(next)
        resolve(changed)
      }
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('Could not mirror local tags.'))
    })
  } finally {
    database.close()
  }
}
