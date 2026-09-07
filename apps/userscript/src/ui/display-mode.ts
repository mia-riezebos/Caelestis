import { warn } from '../debug.js'

export type TemplateDisplayMode = 'tree' | 'grid'

// Keep presentation outside the catalog record, which other open tabs also write.
const STORAGE_KEY = 'caelestis.template-display-mode'
const storage = globalThis as typeof globalThis & {
  GM_getValue?: (key: string, fallback: string) => unknown
  GM_setValue?: (key: string, value: string) => void
}

/** Read the local display preference; missing or invalid preferences use the tree. */
export const templateDisplayMode = (): TemplateDisplayMode => {
  try {
    const value =
      typeof storage.GM_getValue === 'function'
        ? storage.GM_getValue(STORAGE_KEY, 'tree')
        : localStorage.getItem(STORAGE_KEY)
    return value === 'grid' ? 'grid' : 'tree'
  } catch (error) {
    warn('install', 'could not read template display preference', String(error))
    return 'tree'
  }
}

/** Persist a presentation change without writing catalog, ordering, or visibility state. */
export const setTemplateDisplayMode = (mode: TemplateDisplayMode): boolean => {
  try {
    if (typeof storage.GM_setValue === 'function') storage.GM_setValue(STORAGE_KEY, mode)
    else localStorage.setItem(STORAGE_KEY, mode)
    return true
  } catch (error) {
    warn('install', 'could not save template display preference', String(error))
    return false
  }
}
