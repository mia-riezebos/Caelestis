import {
  commitState,
  getState,
  isScopeVisible,
  type LocalFolder,
  MAX_LOCAL_FOLDERS,
} from './state.js'

const folderId = (): string =>
  `lf-${Math.random().toString(36).slice(2, 10)}-${getState().localFolders.length}`

export const createLocalFolder = (parentId: string | null, name: string): LocalFolder | null => {
  if (getState().localFolders.length >= MAX_LOCAL_FOLDERS) return null
  const folder: LocalFolder = {
    id: folderId(),
    parentId,
    name,
    visible: true,
  }
  return commitState({ localFolders: [...getState().localFolders, folder] }) ? folder : null
}

/** An id for a folder that has not been added yet, so a batch can wire up its own parents. */
export const nextLocalFolderId = (): string => folderId()

const leases = new Map<string, number>()

/** Keep a folder alive while an asynchronous template assignment commits to it. */
export const leaseLocalFolder = (id: string): (() => void) | null => {
  if (!getState().localFolders.some((folder) => folder.id === id)) return null
  leases.set(id, (leases.get(id) ?? 0) + 1)
  let active = true
  return () => {
    if (!active) return
    active = false
    const remaining = (leases.get(id) ?? 1) - 1
    if (remaining === 0) leases.delete(id)
    else leases.set(id, remaining)
  }
}

/** Add a validated folder batch in one durable write. */
export const addLocalFolders = (folders: readonly LocalFolder[]): boolean => {
  if (folders.length === 0) return true
  const existing = getState().localFolders
  if (existing.length + folders.length > MAX_LOCAL_FOLDERS) return false
  return commitState({ localFolders: [...existing, ...folders] })
}

export const setLocalFolderVisible = (id: string, visible: boolean): boolean =>
  commitState({
    localFolders: getState().localFolders.map((folder) =>
      folder.id === id ? { ...folder, visible } : folder,
    ),
  })

export const localFolderChainVisible = (folderId: string | null): boolean => {
  if (!isScopeVisible('local')) return false
  const folders = getState().localFolders
  let walk = folderId
  const seen = new Set<string>()
  while (walk !== null) {
    if (seen.has(walk)) return true
    seen.add(walk)
    const folder = folders.find((candidate) => candidate.id === walk)
    if (folder === undefined) return true
    if (folder.visible === false) return false
    walk = folder.parentId
  }
  return true
}

export const renameLocalFolder = (id: string, name: string): boolean => {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 256) return false
  return commitState({
    localFolders: getState().localFolders.map((folder) =>
      folder.id === id ? { ...folder, name: trimmed } : folder,
    ),
  })
}

export const removeLocalFolder = (id: string): boolean => {
  const folders = getState().localFolders
  const folder = folders.find((candidate) => candidate.id === id)
  if (folder === undefined) return true
  if ((leases.get(id) ?? 0) > 0) return false
  return commitState({
    localFolders: folders
      .filter((candidate) => candidate.id !== id)
      .map((candidate) =>
        candidate.parentId === id ? { ...candidate, parentId: folder.parentId } : candidate,
      ),
  })
}

/** Remove a fully validated folder set in one durable write. */
export const removeLocalFolders = (ids: ReadonlySet<string>): boolean => {
  if (ids.size === 0) return true
  const folders = getState().localFolders
  const existing = new Set(folders.map((folder) => folder.id))
  for (const id of ids) {
    if (!existing.has(id) || (leases.get(id) ?? 0) > 0) return false
  }
  if (
    folders.some(
      (folder) => !ids.has(folder.id) && folder.parentId !== null && ids.has(folder.parentId),
    )
  )
    return false
  return commitState({ localFolders: folders.filter((folder) => !ids.has(folder.id)) })
}

export const moveLocalFolder = (id: string, parentId: string | null): boolean => {
  if (id === parentId) return false
  const folders = getState().localFolders
  if (!folders.some((folder) => folder.id === id)) return false
  let walk = parentId
  for (let step = 0; walk !== null; step++) {
    if (walk === id || step > folders.length) return false
    walk = folders.find((candidate) => candidate.id === walk)?.parentId ?? null
  }
  return commitState({
    localFolders: folders.map((folder) => (folder.id === id ? { ...folder, parentId } : folder)),
  })
}
