import { MAX_TEMPLATE_TAGS, type TemplateTag, tagName, tagNameKey, uuidV7 } from '@caelestis/shared'
import type { NativeMetadataStore, NativeTemplate } from './native-store.js'
import type { LocalTag } from './tags.js'

const MAX_NATIVE_TAGS = 8
const MAX_NATIVE_CATALOG = 64
const MAX_NATIVE_TAG_NAME = 24
const NATIVE_TAG_COLOURS = [
  7, 8, 9, 12, 15, 18, 19, 21, 23, 24, 26, 27, 30, 31, 34, 39, 42, 43, 45, 48, 50, 52, 54, 55, 57,
  59, 62,
]

// Wplace's default palette choice, used only when no native colour has been chosen yet.
const nativeTagColour = (name: string): number => {
  let hash = 2166136261
  for (const character of tagNameKey(name)) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return NATIVE_TAG_COLOURS[(hash >>> 0) % NATIVE_TAG_COLOURS.length] ?? 7
}

// Wplace normalizes names on reload. Only export names it can retain without changing them.
const fitsNative = (name: string): boolean =>
  name.length <= MAX_NATIVE_TAG_NAME && !name.startsWith('#') && !/\s/.test(name)

/** Merge assignment edits against the last mirror, retaining labels which do not fit Wplace. */
export const reconcileNativeTags = (
  templateId: string,
  tags: readonly LocalTag[],
  baseline: readonly TemplateTag[],
  native: NativeTemplate,
  catalog: NonNullable<NativeMetadataStore['tagCatalog']>,
) => {
  const nativeNames = native.tags ?? []
  if (
    !Array.isArray(nativeNames) ||
    nativeNames.some((name) => tagName(name) !== name) ||
    new Set(nativeNames.map(tagNameKey)).size !== nativeNames.length
  )
    throw new Error('Unsupported Wplace tags')
  const same = (a: string, b: string): boolean => tagNameKey(a) === tagNameKey(b)
  let assigned = tags.filter((tag) => tag.templateIds.includes(templateId))
  // Local removal or rename detaches the old native name. Native removal detaches only its mirror.
  const names = nativeNames.filter(
    (name) =>
      !baseline.some(
        (old) =>
          same(old.name, name) &&
          !assigned.some((tag) => tag.id === old.id && tag.name === old.name),
      ),
  )
  assigned = assigned.filter(
    (tag) =>
      !baseline.some(
        (old) =>
          old.id === tag.id &&
          old.name === tag.name &&
          !nativeNames.some((name) => same(name, old.name)),
      ),
  )
  const next = [...tags]
  for (const name of names) {
    let tag = next.find((tag) => same(tag.name, name))
    if (tag === undefined) {
      if (next.length >= MAX_TEMPLATE_TAGS) throw new Error('The 256-tag limit was reached.')
      tag = { id: uuidV7(), name, templateIds: [] }
      next.push(tag)
    }
    if (!assigned.some((item) => item.id === tag.id)) assigned.push(tag)
  }
  const available = new Set(catalog.map((tag) => tagNameKey(tag.name)))
  for (const tag of assigned) {
    if (names.some((name) => same(name, tag.name)) || !fitsNative(tag.name)) continue
    const key = tagNameKey(tag.name)
    if (
      names.length >= MAX_NATIVE_TAGS ||
      (!available.has(key) && available.size >= MAX_NATIVE_CATALOG)
    )
      continue
    names.push(tag.name)
    available.add(key)
  }
  // Keep native order and colour choices.
  const selected = new Set(assigned.map((tag) => tag.id))
  const local = next
    .map((tag) => {
      const ids = new Set(tag.templateIds)
      if (selected.has(tag.id)) ids.add(templateId)
      else ids.delete(templateId)
      return { ...tag, templateIds: [...ids] }
    })
    .filter(
      (tag) =>
        tag.templateIds.length > 0 ||
        (tag.folderIds?.length ?? 0) > 0 ||
        !baseline.some((old) => old.id === tag.id && old.name === tag.name) ||
        catalog.some((entry) => same(entry.name, tag.name)),
    )
  const mirrored = names.map((name) => {
    const tag = local.find((tag) => same(tag.name, name))
    if (tag === undefined) throw new Error('Mirrored tag is missing')
    return { id: tag.id, name: tag.name }
  })
  const colours = names.map((name) => {
    const catalogTag = catalog.find((tag) => same(tag.name, name))
    if (catalogTag !== undefined) return catalogTag.colorIdx
    const tag = assigned.find((tag) => same(tag.name, name))
    const oldName = baseline.find((old) => old.id === tag?.id)?.name
    const index = nativeNames.findIndex((value) => same(value, oldName ?? name))
    return native.tagColorIdxs?.[index] ?? nativeTagColour(name)
  })
  return { local, mirrored, names, colours }
}
