/** A reusable label owned by one local store or server. */
export interface TemplateTag {
  readonly id: string
  readonly name: string
}

export const MAX_TAG_NAME_LENGTH = 64
export const MAX_TEMPLATE_TAGS = 256

/** Canonical display name; null rejects blank, oversized, or control-character names. */
export const tagName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFC').trim()
  return name.length > 0 && name.length <= MAX_TAG_NAME_LENGTH && !/[\p{Cc}\p{Cf}]/u.test(name)
    ? name
    : null
}

/** Case-insensitive uniqueness key, independent of the browser's locale. */
export const tagNameKey = (name: string): string => name.normalize('NFC').toLowerCase()

/** Validate tag catalogs and template labels at API and persisted-cache boundaries. */
export const parseTemplateTags = (value: unknown): readonly TemplateTag[] | null => {
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_TAGS) return null
  const ids = new Set<string>()
  const names = new Set<string>()
  const tags: TemplateTag[] = []
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)
    )
      return null
    const name = tagName(item.name)
    if (name === null || name !== item.name || ids.has(item.id) || names.has(tagNameKey(name)))
      return null
    ids.add(item.id)
    names.add(tagNameKey(name))
    tags.push({ id: item.id, name })
  }
  return tags
}
