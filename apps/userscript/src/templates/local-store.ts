import {
  encodeIndexedPng,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { isUint8Array, pageWindow } from '../page-world.js'
import {
  type ConnectedServer,
  getGlobalAppearance,
  getState,
  isScopeVisible,
  type LocalFolder,
  leaseLocalFolder,
  localFolderChainVisible,
  serverTemplatePreference,
  setScopeVisible,
  setServerTemplatePreference,
} from '../state.js'
import {
  APPEARANCE_GROUPS,
  type Appearance,
  type AppearanceGroup,
  GROUP_FIELDS,
  legacyAppearanceGroups,
  normaliseAppearance,
} from './appearance.js'
import {
  type ImportedTemplate,
  MAX_SOURCE_TILES_PER_TEMPLATE,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from './import.js'
import {
  deleteTemplate,
  loadTemplate,
  loadTemplates,
  type SaveResult,
  type StoredTemplate,
  saveTemplate,
  saveTemplateFolders,
  type TemplateLoadBatch,
  type TemplateLoadFailure,
} from './persist.js'
import { horizontalSpans } from './placement.js'
import { nodeChainVisible, serverNodeParents, serverNodesRevision } from './server-nodes.js'

/**
 * Indexed template pixels shared by rendering, mismatch scans, colour picking and local editing.
 *
 * The WebGL renderer uploads the indices directly. Local templates also keep bitmap mip chains for
 * the remaining CPU operations that need them; server templates use manifest tile keys instead.
 */

/**
 * One tile at successively halved resolutions, largest first.
 *
 * Canvas `drawImage` filters from whatever source you give it, so shrinking a 1000px tile into 250
 * screen pixels samples one pixel in sixteen however smooth the interpolation — which on sparse
 * pixel art is exactly the recipe for moiré. Drawing from a level already near the target size is
 * what mipmapping does, and it is the difference between shimmering and not.
 *
 * wplace itself ships no mipmaps (measured: zero `generateMipmap` calls), so this is deliberately
 * better than matching them rather than merely matching them.
 */
export interface TileLevels {
  readonly levels: readonly ImageBitmap[]
}

export interface PlacedTemplate extends ImportedTemplate {
  /** Keyed `x/y`; local templates retain bitmap mip chains for legacy CPU operations. */
  readonly tiles: ReadonlyMap<string, TileLevels>
  readonly visible: boolean
  /**
   * Whether a placement has ever been applied to this template.
   *
   * A freshly imported image has never been anywhere, so cancelling its first placement should
   * remove it rather than leave it stranded at a position nobody chose.
   */
  readonly everPlaced: boolean
  /**
   * Values this template has set for itself, for whichever groups it owns.
   *
   * Null is not the same as a copy of the default. A template that has never been adjusted should
   * track the global sliders as they move; one that has been adjusted must keep what was set on it.
   * Storing a copy at creation would freeze every new template at whatever the global happened to be
   * that day and quietly stop it following anything.
   */
  readonly appearance: Appearance | null
  /** IndexedDB compare-and-swap token; not part of template identity or rendering. */
  readonly revision: number
  /**
   * Which groups the values above actually govern.
   *
   * Ownership is per group rather than all-or-nothing, so a template can carry its own marker
   * colour while still following the global shape and colour filter. Empty means it follows the
   * defaults in every respect, which is where every template starts.
   */
  readonly owns: readonly AppearanceGroup[]
  /** Which Local folder this sits in, or null for the top level of Local. */
  readonly folderId: string | null
  /**
   * The server publishing this template, or absent for one that only exists in this browser.
   *
   * Server templates live in this same store deliberately. Everything downstream — the renderer, the
   * mismatch scan, the colour picker, the per-overlay menu — takes a `PlacedTemplate` and does not
   * care where it came from, and keeping a second parallel store would have meant teaching all of
   * them the difference for no gain. What *is* different is ownership: these are not persisted here,
   * because the server is where they live and a stale copy in IndexedDB would outlive a delete.
   */
  readonly serverUrl?: string
  /** Its id on that server, which is what the admin routes address. */
  readonly serverTemplateId?: string
  /** The folder it hangs off on that server, or null when it sits at the server root. */
  readonly serverNodeId?: string | null
  /** The version these pixels came from, so a sync knows whether to re-download them. */
  readonly serverVersion?: string
  /** The source continues at x=0 after reaching the world's east edge. Server templates only. */
  readonly wrapX?: boolean
  /** Painted world tiles advertised by the server manifest. Server templates only. */
  readonly serverTileKeys?: readonly string[]
}

/** Whether this template is a copy of something a server publishes. */
export const isServerTemplate = (template: PlacedTemplate): boolean =>
  template.serverUrl !== undefined

const templates = new Map<string, PlacedTemplate>()
// Effective visibility can temporarily differ from durable user intent when source bitmap
// construction is unavailable. Keep that intent out of the public render model, but preserve it
// across unrelated writes and cross-tab reconciliation.
const desiredVisibility = new Map<string, boolean>()
const reconciliationObservers = new Map<string, Set<() => void>>()
const previewOrigins = new Map<string, { x: number; y: number }>()
const deleting = new Set<string>()
const deletionLeases = new Map<string, number>()
const pendingAdds = new Set<string>()
const listeners: Array<() => void> = []
const previewListeners: Array<() => void> = []
const MAX_LOCAL_TEMPLATES = 64
const MAX_LOCAL_INDEX_PIXELS = 64 * 1024 * 1024
const MAX_RESTORE_CANDIDATES = MAX_LOCAL_TEMPLATES * 4
const MAX_RESTORE_HYDRATED_PIXELS = MAX_LOCAL_INDEX_PIXELS * 2
let retainedIndexPixels = 0
let pendingIndexPixels = 0
let restoreInFlight: Promise<void> | null = null
let scheduledRestoreRecovery: Promise<void> | null = null
let reconciliationTail: Promise<void> = Promise.resolve()
let templateRevision = 0
let orderedCacheRevision = -1
let orderedCache: readonly PlacedTemplate[] = []

/** @internal Pure arithmetic seam for proving concurrent aggregate-budget reservations. */
export const indexIncreaseWithinBudget = (
  retained: number,
  pending: number,
  current: number,
  next: number,
  limit: number,
): number | null => {
  const increase = Math.max(0, next - current)
  return retained + pending + increase <= limit ? increase : null
}

const reserveIndexIncrease = (currentPixels: number, nextPixels: number): (() => void) | null => {
  const increase = indexIncreaseWithinBudget(
    retainedIndexPixels,
    pendingIndexPixels,
    currentPixels,
    nextPixels,
    MAX_LOCAL_INDEX_PIXELS,
  )
  if (increase === null) return null
  pendingIndexPixels += increase
  return () => {
    pendingIndexPixels -= increase
  }
}

export const onLocalReconciliation = (id: string, observer: () => void): (() => void) => {
  const observers = reconciliationObservers.get(id) ?? new Set<() => void>()
  observers.add(observer)
  reconciliationObservers.set(id, observers)
  return () => {
    observers.delete(observer)
    if (observers.size === 0) reconciliationObservers.delete(id)
  }
}

const noteReconciliation = (id: string): void => {
  for (const observer of reconciliationObservers.get(id) ?? []) {
    try {
      observer()
    } catch (error) {
      warn('install', 'local reconciliation observer failed', String(error))
    }
  }
}

const orderedTemplates = (): readonly PlacedTemplate[] => {
  if (orderedCacheRevision === templateRevision) return orderedCache
  orderedCache = [...templates.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  orderedCacheRevision = templateRevision
  return orderedCache
}

const customOrdered = <T extends { readonly key: string }>(
  items: readonly T[],
  rank: ReadonlyMap<string, number>,
): readonly T[] => {
  const ranked: Array<T & { readonly rank: number }> = []
  const unranked: T[] = []
  for (const item of items) {
    const itemRank = rank.get(item.key)
    if (itemRank === undefined) unranked.push(item)
    else ranked.push({ ...item, rank: itemRank })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  return [...ranked, ...unranked]
}

const serverTreeIdentity = (serverUrl: string): string => {
  const verified = getState().servers.find((server) => server.url === serverUrl)?.lastVerified
  return verified == null ? 'unknown:unknown' : `${verified.serverId}:${verified.season}`
}

/** Flatten one tree in the same custom sibling order the panel shows. */
const flattenTree = (
  rows: readonly PlacedTemplate[],
  folders: readonly (readonly [id: string, parentId: string | null])[],
  folderKey: (id: string) => string,
  templateKey: (template: PlacedTemplate) => string,
  templateParent: (template: PlacedTemplate) => string | null,
  rank: ReadonlyMap<string, number>,
): readonly PlacedTemplate[] => {
  const result: PlacedTemplate[] = []
  const seenFolders = new Set<string>()
  const seenTemplates = new Set<string>()
  const foldersByParent = new Map<string | null, string[]>()
  const templatesByParent = new Map<string | null, PlacedTemplate[]>()
  for (const [id, parentId] of folders) {
    const siblings = foldersByParent.get(parentId) ?? []
    siblings.push(id)
    foldersByParent.set(parentId, siblings)
  }
  for (const template of rows) {
    const parentId = templateParent(template)
    const siblings = templatesByParent.get(parentId) ?? []
    siblings.push(template)
    templatesByParent.set(parentId, siblings)
  }
  const childrenOf = (parentId: string | null) =>
    customOrdered(
      [
        ...(foldersByParent.get(parentId) ?? []).map((id) => ({
          key: folderKey(id),
          kind: 'folder' as const,
          id,
        })),
        ...(templatesByParent.get(parentId) ?? []).map((template) => ({
          key: templateKey(template),
          kind: 'template' as const,
          template,
        })),
      ],
      rank,
    )
  const stack = [...childrenOf(null)].reverse()
  while (stack.length > 0) {
    const child = stack.pop()
    if (child === undefined) break
    if (child.kind === 'template') {
      if (seenTemplates.has(child.template.id)) continue
      seenTemplates.add(child.template.id)
      result.push(child.template)
    } else if (!seenFolders.has(child.id)) {
      seenFolders.add(child.id)
      stack.push(...[...childrenOf(child.id)].reverse())
    }
  }
  // Invalid or temporarily incomplete parent data must not make an otherwise valid overlay vanish.
  for (const template of rows) {
    if (!seenTemplates.has(template.id)) result.push(template)
  }
  return result
}

const displayOrder = (): readonly PlacedTemplate[] => {
  const ordered = orderedTemplates()
  const state = getState()
  const rank = new Map(state.customOrder.map((key, index) => [key, index]))
  const categories = [
    {
      key: 'local',
      rows: flattenTree(
        ordered.filter((template) => !isServerTemplate(template)),
        state.localFolders.map((folder) => [folder.id, folder.parentId] as const),
        (id) => `lf:${id}`,
        (template) => `local:${template.id}`,
        (template) => template.folderId,
        rank,
      ),
    },
    ...state.servers.map((server) => {
      const identity = serverTreeIdentity(server.url)
      return {
        key: `server:${server.url}`,
        rows: flattenTree(
          ordered.filter((template) => template.serverUrl === server.url),
          serverNodeParents(server.url),
          (id) => `node:${encodeURIComponent(server.url)}:${identity}:${id}`,
          (template) =>
            `st:${encodeURIComponent(server.url)}:${identity}:${template.serverTemplateId ?? ''}`,
          (template) => template.serverNodeId ?? null,
          rank,
        ),
      }
    }),
  ]
  const result = customOrdered(categories, rank).flatMap(({ rows }) => rows)
  const included = new Set(result.map((template) => template.id))
  return [...result, ...ordered.filter((template) => !included.has(template.id))]
}

export const onLocalChange = (listener: () => void): void => {
  listeners.push(listener)
}
export const onLocalPreviewChange = (listener: () => void): void => {
  previewListeners.push(listener)
}

const notifyListeners = (subscribers: readonly (() => void)[], what: string): void => {
  for (const listener of subscribers) {
    try {
      listener()
    } catch (error) {
      try {
        warn('install', `${what} listener failed`, String(error))
      } catch {}
    }
  }
}

const notify = (): void => {
  templateRevision++
  // Mirror a summary onto the window so the dev harness can assert on placement without reaching
  // into module state. Metadata only — never the pixels.
  try {
    ;(pageWindow() as unknown as Record<string, unknown>).__caelestisLocal = orderedTemplates().map(
      (t) => ({
        id: t.id,
        name: t.name,
        source: t.source,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
        tiles: t.tiles.size,
        folderId: t.folderId,
      }),
    )
  } catch (error) {
    try {
      warn('install', 'could not update local template diagnostics', String(error))
    } catch {}
  }
  notifyListeners(listeners, 'local template')
}

const notifyPreview = (): void => notifyListeners(previewListeners, 'local preview')

export const localTemplates = (): readonly PlacedTemplate[] => orderedTemplates()

/** Current catalog entry for one template id, without allocating or sorting the collection. */
export const templateById = (id: string): PlacedTemplate | undefined => templates.get(id)

/** Ordered template ids directly inside one Local folder. */
export const templateIdsInLocalFolder = (folderId: string): readonly string[] =>
  orderedTemplates()
    .filter((template) => !isServerTemplate(template) && template.folderId === folderId)
    .map((template) => template.id)

/** Indexed template pixels currently owned by the catalog. */
export const templateIndexMemoryBytes = (): number => retainedIndexPixels

/** Whether this exact snapshot is still the installed version of its template. */
export const isCurrentTemplate = (template: PlacedTemplate): boolean =>
  templateById(template.id) === template

/** Keep a browser-owned template from being deleted while another copy is still being committed. */
export const leaseLocalTemplate = (id: string): (() => void) | null => {
  const template = templates.get(id)
  if (template === undefined || isServerTemplate(template) || deleting.has(id)) return null
  deletionLeases.set(id, (deletionLeases.get(id) ?? 0) + 1)
  let active = true
  return () => {
    if (!active) return
    active = false
    const remaining = (deletionLeases.get(id) ?? 1) - 1
    if (remaining === 0) deletionLeases.delete(id)
    else deletionLeases.set(id, remaining)
  }
}

let displayOrderCache:
  | {
      readonly customOrder: readonly string[]
      readonly localFolders: readonly LocalFolder[]
      readonly servers: readonly ConnectedServer[]
      readonly nodeRevision: number
      readonly templateRevision: number
      readonly templates: readonly PlacedTemplate[]
    }
  | undefined
/** Templates as the canvas and its interactions currently present them: custom order plus previews. */
export const displayTemplates = (): readonly PlacedTemplate[] => {
  const state = getState()
  const nodeRevision = serverNodesRevision()
  if (
    displayOrderCache === undefined ||
    displayOrderCache.customOrder !== state.customOrder ||
    displayOrderCache.localFolders !== state.localFolders ||
    displayOrderCache.servers !== state.servers ||
    displayOrderCache.nodeRevision !== nodeRevision ||
    displayOrderCache.templateRevision !== templateRevision
  ) {
    displayOrderCache = {
      customOrder: state.customOrder,
      localFolders: state.localFolders,
      servers: state.servers,
      nodeRevision,
      templateRevision,
      templates: displayOrder(),
    }
  }
  if (previewOrigins.size === 0) return displayOrderCache.templates
  return displayOrderCache.templates.map((template) => {
    const preview = previewOrigins.get(template.id)
    return preview === undefined
      ? template
      : { ...template, originX: preview.x, originY: preview.y }
  })
}

/** Transient placement never touches IndexedDB or rebuilds tiles; the renderer translates them. */
export const previewLocalTemplate = (id: string, originX: number, originY: number): boolean => {
  const existing = templates.get(id)
  if (existing === undefined || deleting.has(id)) return false
  const x = Math.round(originX)
  const y = Math.round(originY)
  validatePlacement(existing, x, y)
  previewOrigins.set(id, { x, y })
  notifyPreview()
  return true
}

export const previewOriginFor = (id: string): { x: number; y: number } | null =>
  previewOrigins.get(id) ?? null

export const clearLocalPreview = (id: string): boolean => {
  if (!previewOrigins.delete(id)) return templates.has(id)
  notifyPreview()
  return true
}

/**
 * Whether this template actually draws.
 *
 * Its own switch *and* every folder above it. A template inside a hidden folder keeps saying it is
 * visible, because it is — within a group that is not — and that is what makes turning the group
 * back on restore the arrangement instead of flattening it.
 */
export const isTemplateVisible = (template: PlacedTemplate): boolean => {
  if (!template.visible) return false
  // A server's template answers to that server's switch, not to Local's. Sharing this store meant
  // it inherited the local chain by default, so switching Local off hid every server's templates
  // too, and a server's own switch did nothing to them.
  //
  // And to the folders it sits in, the same way a Local template answers to its own. A server's
  // folders had no chain here at all, so their switches fell through to a set the renderer never
  // read: the box moved, and nothing else did.
  if (template.serverUrl !== undefined) {
    if (!isScopeVisible(`server:${template.serverUrl}`)) return false
    return nodeChainVisible(template.serverUrl, template.serverNodeId ?? null)
  }
  return localFolderChainVisible(template.folderId)
}

/**
 * How this template is actually drawn: its own appearance, or the global default it inherits.
 *
 * The global colour filter lives beside the global appearance rather than inside it — the colour
 * grid writes `hiddenColours` on the state directly — so the inherited object has to be completed
 * from both. Without this an overlay showed an empty filter while following defaults that hid half
 * the palette, and switching "use defaults" off copied that empty filter over the top, quietly
 * turning every hidden colour back on at the moment of detaching.
 */
export const appearanceOf = (template: PlacedTemplate): Appearance => {
  const state = getState()
  const global: Appearance = { ...getGlobalAppearance(), hiddenColours: state.hiddenColours }
  const own = template.appearance
  if (own === null || template.owns.length === 0) return global

  // Field by field, from whichever side owns that field's group. A template that has taken over its
  // markers still follows the global sliders for its shape, which is the whole point of splitting
  // the switch: wanting one's own marker colour used to mean freezing everything else as well.
  const composed: Record<string, unknown> = { ...global }
  for (const group of template.owns) {
    for (const field of GROUP_FIELDS[group]) composed[field] = own[field]
  }
  return composed as unknown as Appearance
}

/** Whether this template answers for itself on one group, or follows the defaults. */
export const ownsGroup = (template: PlacedTemplate, group: AppearanceGroup): boolean =>
  template.owns.includes(group)

/**
 * Slice a template into tile-sized bitmaps.
 *
 * Transparent tiles are dropped rather than stored empty: a template with a sparse bounding box
 * otherwise pays for every tile in that box on every frame, and most large templates are sparse.
 */
/** Halve until small, so any on-screen size has a source within 2x of it. */
const MIN_MIP_SIZE = 125
// Every retained source tile is a fixed 1000/500/250/125 chain (~5.3 MB). Budget the actual
// painted tiles across all templates; pixel count alone does not bound a very wide, short image.
const MAX_RETAINED_SOURCE_TILES = 24
const MAX_SOURCE_TILES_DURING_REPLACEMENT =
  MAX_RETAINED_SOURCE_TILES + MAX_SOURCE_TILES_PER_TEMPLATE
let retainedSourceTiles = 0
let candidateSourceTiles = 0
let pendingSourceIncrease = 0

const reserveSourceTile = (): boolean => {
  if (retainedSourceTiles + candidateSourceTiles >= MAX_SOURCE_TILES_DURING_REPLACEMENT) {
    return false
  }
  candidateSourceTiles++
  return true
}

const claimSourceReplacement = (before: number, after: number): boolean => {
  const increase = Math.max(0, after - before)
  if (retainedSourceTiles + pendingSourceIncrease + increase > MAX_RETAINED_SOURCE_TILES) {
    return false
  }
  pendingSourceIncrease += increase
  return true
}

const cancelSourceClaim = (before: number, after: number): void => {
  pendingSourceIncrease -= Math.max(0, after - before)
}

const installSourceReplacement = (before: number, after: number): void => {
  pendingSourceIncrease -= Math.max(0, after - before)
  retainedSourceTiles += after - before
  candidateSourceTiles -= after
}

const closeLevels = (tile: TileLevels): void => {
  for (const level of tile.levels) level.close()
}

const closeTiles = (tiles: ReadonlyMap<string, TileLevels>): void => {
  for (const tile of tiles.values()) closeLevels(tile)
}

const releaseCandidateTiles = (tiles: ReadonlyMap<string, TileLevels>): void => {
  candidateSourceTiles -= tiles.size
  closeTiles(tiles)
}

const releaseRetainedTiles = (tiles: ReadonlyMap<string, TileLevels>): void => {
  retainedSourceTiles -= tiles.size
  closeTiles(tiles)
}

const yieldToBrowser = async (): Promise<void> => {
  const browserScheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler
  if (browserScheduler?.yield !== undefined) {
    await browserScheduler.yield()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const buildLevels = async (full: ImageData): Promise<ImageBitmap[]> => {
  const levels: ImageBitmap[] = []
  try {
    levels.push(await createImageBitmap(full))
    let width = full.width
    let height = full.height
    let source: CanvasImageSource = levels[0] as ImageBitmap
    while (Math.max(width, height) > MIN_MIP_SIZE) {
      width = Math.max(1, Math.floor(width / 2))
      height = Math.max(1, Math.floor(height / 2))
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (context === null) break
      // Smooth *between* levels: each is a proper average of the one above, which is where the
      // anti-aliasing actually comes from.
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(source, 0, 0, width, height)
      const next = await createImageBitmap(canvas)
      levels.push(next)
      source = next
    }
    return levels
  } catch (error) {
    for (const level of levels) level.close()
    throw error
  }
}

const validatePlacement = (
  template: ImportedTemplate,
  originX = template.originX,
  originY = template.originY,
): void => {
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new RangeError('template origin must be whole canvas pixels')
  }
  if (
    !Number.isSafeInteger(template.width) ||
    !Number.isSafeInteger(template.height) ||
    template.width <= 0 ||
    template.height <= 0 ||
    template.indices.length !== template.width * template.height
  ) {
    throw new RangeError('template dimensions do not match its pixels')
  }
  if (originX < 0 || originY < 0) throw new RangeError('template origin is outside the canvas')
  if (originX + template.width > WORLD_PIXELS) {
    if (
      !('wrapX' in template) ||
      template.wrapX !== true ||
      !('serverUrl' in template) ||
      typeof template.serverUrl !== 'string' ||
      template.width >= WORLD_PIXELS ||
      originX + template.width > WORLD_PIXELS * 2
    ) {
      throw new RangeError('template runs past the east edge')
    }
  }
  if (originY + template.height > WORLD_PIXELS)
    throw new RangeError('template runs past the south edge')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTemplateLoadFailure = (value: unknown): value is TemplateLoadFailure =>
  isRecord(value) &&
  !('indices' in value) &&
  value.kind === 'template-hydration-failure' &&
  (value.status === 'invalid' || value.status === 'unavailable' || value.status === 'skipped') &&
  (typeof value.id === 'string' || 'key' in value) &&
  Number.isSafeInteger(value.revision) &&
  Number.isSafeInteger(value.indexPixels) &&
  (value.indexPixels as number) >= 0

const isAppearance = (value: unknown): value is Appearance => {
  if (!isRecord(value)) return false
  const { size, radius, translateX, translateY, rotation, opacity, hiddenColours } = value
  return (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= 0.05 &&
    size <= 2 &&
    typeof radius === 'number' &&
    Number.isFinite(radius) &&
    radius >= 0 &&
    radius <= 1 &&
    typeof translateX === 'number' &&
    Number.isFinite(translateX) &&
    translateX >= -1 &&
    translateX <= 1 &&
    typeof translateY === 'number' &&
    Number.isFinite(translateY) &&
    translateY >= -1 &&
    translateY <= 1 &&
    typeof rotation === 'number' &&
    Number.isFinite(rotation) &&
    rotation >= 0 &&
    rotation <= 360 &&
    typeof opacity === 'number' &&
    Number.isFinite(opacity) &&
    opacity >= 0.05 &&
    opacity <= 1 &&
    Array.isArray(hiddenColours) &&
    hiddenColours.length <= WPLACE_PALETTE.length &&
    hiddenColours.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < WPLACE_PALETTE.length,
    ) &&
    new Set(hiddenColours).size === hiddenColours.length
  )
}

const normaliseStoredTemplate = (value: unknown): StoredTemplate => {
  if (!isRecord(value)) throw new RangeError('template record is not an object')
  const {
    id,
    name,
    source,
    sortOrder,
    originX,
    originY,
    width,
    height,
    indices,
    moved,
    opaque,
    visible,
    everPlaced,
    appearance,
    owns,
    revision,
    folderId,
  } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TEMPLATE_ID_LENGTH) {
    throw new RangeError('template id is invalid')
  }
  if (typeof name !== 'string' || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new RangeError('template name is invalid')
  }
  if (typeof source !== 'string' || !['wplace', 'marble', 'image'].includes(source)) {
    throw new RangeError('template source is invalid')
  }
  if (sortOrder !== undefined && !Number.isSafeInteger(sortOrder)) {
    throw new RangeError('template sort order is invalid')
  }
  if (!isUint8Array(indices)) throw new RangeError('template pixels are invalid')
  if (
    !Number.isSafeInteger(moved) ||
    !Number.isSafeInteger(opaque) ||
    (moved as number) < 0 ||
    (opaque as number) <= 0 ||
    (moved as number) > (opaque as number) ||
    (opaque as number) > indices.length
  ) {
    throw new RangeError('template pixel counts are invalid')
  }
  if (typeof visible !== 'boolean' || typeof everPlaced !== 'boolean') {
    throw new RangeError('template state is invalid')
  }
  if (
    revision !== undefined &&
    (!Number.isSafeInteger(revision) ||
      (revision as number) < 0 ||
      (revision as number) >= Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError('template revision is invalid')
  }
  if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
    throw new RangeError('template folder is invalid')
  }
  if (
    owns !== undefined &&
    (!Array.isArray(owns) ||
      owns.some((group) => !APPEARANCE_GROUPS.includes(group as AppearanceGroup)) ||
      new Set(owns).size !== owns.length)
  ) {
    throw new RangeError('template appearance ownership is invalid')
  }
  const normalised: StoredTemplate = {
    id,
    name,
    source: source as StoredTemplate['source'],
    originX: originX as number,
    originY: originY as number,
    width: width as number,
    height: height as number,
    indices,
    moved: moved as number,
    opaque: opaque as number,
    visible,
    everPlaced,
    revision: revision === undefined ? 0 : (revision as number),
    folderId: typeof folderId === 'string' ? folderId : null,
    appearance: normaliseAppearance(appearance),
    // "It has an appearance, so it chose one" holds for a record written by this model. A record
    // from before it carries `shape`, and every template got one whether or not anyone touched it,
    // so reading that as a deliberate choice would detach it from the global sliders for good.
    owns:
      owns === undefined
        ? appearance == null
          ? []
          : legacyAppearanceGroups(appearance)
        : (owns as AppearanceGroup[]),
    ...(sortOrder === undefined ? {} : { sortOrder: sortOrder as number }),
  }
  validatePlacement(normalised)
  return normalised
}

const validateStoredPixels = async (template: StoredTemplate): Promise<void> => {
  let opaque = 0
  const paintedTiles = new Set<number>()
  const worldTilesWide = Math.ceil(WORLD_PIXELS / TILE_SIZE)
  let sourceX = 0
  let sourceY = 0
  let lastPaintedTile = -1
  for (let pixel = 0; pixel < template.indices.length; pixel++) {
    const index = template.indices[pixel] ?? TRANSPARENT_INDEX
    if (index !== TRANSPARENT_INDEX) {
      if (index >= WPLACE_PALETTE.length) throw new RangeError('template palette index is invalid')
      opaque++
      const tileX = Math.floor((template.originX + sourceX) / TILE_SIZE)
      const tileY = Math.floor((template.originY + sourceY) / TILE_SIZE)
      const tile = tileY * worldTilesWide + tileX
      if (tile !== lastPaintedTile) {
        lastPaintedTile = tile
        paintedTiles.add(tile)
        if (paintedTiles.size > MAX_SOURCE_TILES_PER_TEMPLATE) {
          throw new RangeError('template covers too many painted tiles to render safely')
        }
      }
    }
    sourceX++
    if (sourceX === template.width) {
      sourceX = 0
      sourceY++
    }
    if ((pixel + 1) % 1_000_000 === 0) await yieldToBrowser()
  }
  if (opaque !== template.opaque) throw new RangeError('template opaque count is invalid')
}

const slice = async (
  template: ImportedTemplate & { readonly serverUrl?: string; readonly wrapX?: boolean },
): Promise<Map<string, TileLevels>> => {
  validatePlacement(template)
  await yieldToBrowser()
  const firstTileY = Math.floor(template.originY / TILE_SIZE)
  const lastTileY = Math.floor((template.originY + template.height - 1) / TILE_SIZE)

  const out = new Map<string, TileLevels>()
  let scanWork = 0
  try {
    for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
      for (const span of horizontalSpans(template)) {
        const firstTileX = Math.floor(span.worldStart / TILE_SIZE)
        const lastTileX = Math.floor((span.worldEnd - 1) / TILE_SIZE)
        for (let tileX = firstTileX; tileX <= lastTileX; tileX++) {
          // Allocate a full tile only once a painted source pixel is found. Sparse Marble extents can
          // cross thousands of empty tile rows; eagerly allocating 4 MB for every empty tile turns a
          // small valid import into gigabytes of allocation churn.
          let rgba: Uint8ClampedArray<ArrayBuffer> | null = null
          const tileLeft = tileX * TILE_SIZE
          const tileTop = tileY * TILE_SIZE
          const startX = span.sourceStart + Math.max(0, tileLeft - span.worldStart)
          const startY = Math.max(0, tileTop - template.originY)
          const endX =
            span.sourceStart +
            Math.min(span.sourceEnd - span.sourceStart, tileLeft + TILE_SIZE - span.worldStart)
          const endY = Math.min(template.height, tileTop + TILE_SIZE - template.originY)

          for (let y = startY; y < endY; y++) {
            const rowOffset = y * template.width
            const targetRow = (template.originY + y - tileTop) * TILE_SIZE
            for (let x = startX; x < endX; x++) {
              const index = template.indices[rowOffset + x] ?? TRANSPARENT_INDEX
              if (index === TRANSPARENT_INDEX) continue
              const colour = WPLACE_PALETTE[index]
              if (colour === undefined) continue
              rgba ??= new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
              const worldX = span.worldStart + x - span.sourceStart
              const target = (targetRow + (worldX - tileLeft)) * 4
              rgba[target] = colour.rgb[0]
              rgba[target + 1] = colour.rgb[1]
              rgba[target + 2] = colour.rgb[2]
              rgba[target + 3] = 255
            }
            scanWork += endX - startX
            if (scanWork >= 250_000) {
              scanWork = 0
              await yieldToBrowser()
            }
          }
          if (rgba === null) continue
          if (out.size >= MAX_SOURCE_TILES_PER_TEMPLATE) {
            throw new RangeError('template covers too many painted tiles to render safely')
          }
          // Reserve before allocating the chain. Existing replacement tiles remain counted until
          // the atomic swap closes them, so the cap covers the actual old-plus-new peak.
          if (!reserveSourceTile()) {
            throw new RangeError('local templates exceed the source bitmap memory budget')
          }
          try {
            out.set(`${tileX}/${tileY}`, {
              levels: await buildLevels(new ImageData(rgba, TILE_SIZE, TILE_SIZE)),
            })
          } catch (error) {
            candidateSourceTiles--
            throw error
          }
        }
      }
    }
    return out
  } catch (error) {
    releaseCandidateTiles(out)
    throw error
  }
}

const writeTails = new Map<string, Promise<unknown>>()

const writeInOrder = <T>(id: string, write: () => Promise<T>): Promise<T> => {
  const previous = writeTails.get(id) ?? Promise.resolve()
  const next = previous.then(write, write)
  writeTails.set(id, next)
  const release = (): void => {
    if (writeTails.get(id) === next) writeTails.delete(id)
  }
  // Give the cleanup chain both handlers so a failed write cannot create a second, unobserved
  // rejected promise through `finally`.
  void next.then(release, release)
  return next
}

const writeManyInOrder = <T>(ids: readonly string[], write: () => Promise<T>): Promise<T> => {
  const unique = [...new Set(ids)].sort()
  const previous = Promise.all(
    unique.map(async (id) => {
      try {
        await (writeTails.get(id) ?? Promise.resolve())
      } catch {}
    }),
  )
  const next = previous.then(write)
  for (const id of unique) writeTails.set(id, next)
  const release = (): void => {
    for (const id of unique) {
      if (writeTails.get(id) === next) writeTails.delete(id)
    }
  }
  void next.then(release, release)
  return next
}

const persist = async (placed: PlacedTemplate): Promise<SaveResult> => {
  if (isServerTemplate(placed)) {
    return setServerTemplatePreference(placed.id, placed.appearance, placed.owns)
      ? { status: 'saved', revision: placed.revision }
      : { status: 'limit' }
  }
  const { tiles: _tiles, ...rest } = placed
  return await writeInOrder(placed.id, async () => await saveTemplate(rest, null))
}

const savePlaced = async (
  placed: PlacedTemplate,
  expectedRevision: number | null = placed.revision,
  visible: boolean = desiredVisibility.get(placed.id) ?? placed.visible,
): Promise<SaveResult> => {
  if (isServerTemplate(placed)) {
    return setServerTemplatePreference(placed.id, placed.appearance, placed.owns)
      ? { status: 'saved', revision: placed.revision }
      : { status: 'limit' }
  }
  const { tiles: _tiles, ...rest } = placed
  return await saveTemplate({ ...rest, visible }, expectedRevision)
}

// A plain image has no meaningful position until its first placement is applied. Keep it local
// until then so a second tab restoring IndexedDB cannot mistake an active placement for crash
// residue and delete it underneath the owner.
const isPendingImage = (template: PlacedTemplate): boolean =>
  template.source === 'image' && !template.everPlaced

const removeStaleLocalState = (existing: PlacedTemplate): void => {
  releaseRetainedTiles(existing.tiles)
  retainedIndexPixels -= existing.indices.length
  desiredVisibility.delete(existing.id)
  clearStamped(existing.id)
  previewOrigins.delete(existing.id)
  templates.delete(existing.id)
  noteReconciliation(existing.id)
  notify()
}

/** Replace stale process-local state with the durable winner after an IndexedDB CAS conflict. */
const reconcileConflictExclusive = async (id: string): Promise<void> => {
  const MAX_RECONCILIATION_ATTEMPTS = 4
  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt++) {
    const existing = templates.get(id)
    if (existing === undefined) return
    const loaded = await loadTemplate(id, MAX_LOCAL_INDEX_PIXELS)
    if (loaded.status === 'unavailable') return
    if (loaded.status === 'missing') {
      removeStaleLocalState(existing)
      return
    }
    if (loaded.status === 'invalid') {
      const deleted = await deleteTemplate(id, loaded.revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn('install', `could not remove invalid conflict winner for ${existing.name}`)
      return
    }
    let winner: StoredTemplate
    try {
      winner = normaliseStoredTemplate(loaded.template)
      if (winner.id !== id || (winner.source === 'image' && !winner.everPlaced)) {
        throw new RangeError('winning template state is invalid')
      }
    } catch (error) {
      const raw = isRecord(loaded.template) ? loaded.template : {}
      const revision =
        Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0
      const deleted = await deleteTemplate(id, revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(
        'install',
        `could not remove invalid conflict winner for ${existing.name}`,
        String(error),
      )
      return
    }
    const releaseIndexReservation = reserveIndexIncrease(
      existing.indices.length,
      winner.indices.length,
    )
    if (releaseIndexReservation === null) {
      warn('install', `could not reconcile stale local template ${existing.name}: pixel budget`)
      return
    }
    try {
      try {
        await validateStoredPixels(winner)
      } catch (error) {
        const deleted = await deleteTemplate(id, winner.revision)
        if (deleted.status === 'saved') {
          removeStaleLocalState(existing)
          return
        }
        if (deleted.status === 'conflict') continue
        warn(
          'install',
          `could not remove invalid conflict winner for ${existing.name}`,
          String(error),
        )
        return
      }
      let visible = winner.visible
      let tiles = new Map<string, TileLevels>()
      if (visible) {
        if (
          retainedSourceTiles + pendingSourceIncrease - existing.tiles.size >=
          MAX_RETAINED_SOURCE_TILES
        ) {
          visible = false
        } else {
          try {
            const candidate = await slice(winner)
            if (claimSourceReplacement(existing.tiles.size, candidate.size)) {
              tiles = candidate
            } else {
              releaseCandidateTiles(candidate)
              visible = false
            }
          } catch (error) {
            visible = false
            warn('install', `reconciled ${winner.name} hidden: source rendering unavailable`, error)
          }
        }
      }
      if (!visible && !claimSourceReplacement(existing.tiles.size, 0)) {
        warn('install', `could not reconcile stale local template ${existing.name}: bitmap budget`)
        return
      }
      clearStamped(id)
      previewOrigins.delete(id)
      templates.set(id, {
        ...winner,
        appearance: winner.appearance ?? null,
        owns: winner.owns ?? (winner.appearance != null ? APPEARANCE_GROUPS : []),
        folderId: winner.folderId ?? null,
        visible,
        tiles,
      })
      if (visible === winner.visible) desiredVisibility.delete(id)
      else desiredVisibility.set(id, winner.visible)
      retainedIndexPixels += winner.indices.length - existing.indices.length
      installSourceReplacement(existing.tiles.size, tiles.size)
      closeTiles(existing.tiles)
      noteReconciliation(id)
      notify()
      return
    } finally {
      releaseIndexReservation()
    }
  }
  warn('install', `could not reconcile ${id}: conflict retry limit reached`)
}

const reconcileConflict = async (id: string): Promise<void> => {
  const running = reconciliationTail.then(
    async () => await reconcileConflictExclusive(id),
    async () => await reconcileConflictExclusive(id),
  )
  reconciliationTail = running.then(
    () => undefined,
    () => undefined,
  )
  await running
}

const committedRevision = (result: SaveResult): number | null =>
  result.status === 'saved' ? result.revision : null

/**
 * Is there room for this server template, before anything is downloaded for it?
 *
 * `putServerTemplate` refuses past the budget, but only after its caller has fetched and decoded the
 * pixels. A server is free to advertise a manifest far larger than the budget, so the caller needs to
 * know before it spends the work. Admission is based on decoded pixels, the resource the WebGL
 * renderer actually retains, rather than an arbitrary template count.
 */
export const hasRoomForServerTemplate = (id: string, nextPixels: number): boolean => {
  if (!Number.isSafeInteger(nextPixels) || nextPixels < 0) return false
  const existing = templates.get(id)
  if (existing !== undefined && !isServerTemplate(existing)) return false
  return (
    indexIncreaseWithinBudget(
      retainedIndexPixels,
      pendingIndexPixels,
      existing?.indices.length ?? 0,
      nextPixels,
      MAX_LOCAL_INDEX_PIXELS,
    ) !== null
  )
}

/**
 * Put a template published by a server into the store, replacing any earlier copy of it.
 *
 * Its local switches survive the replacement: whether it is showing and how it is drawn are this
 * browser's opinions about someone else's template, and re-syncing pixels is no reason to discard
 * them. Everything else — the name, where it sits, the pixels — comes from the server.
 */
export const putServerTemplate = async (
  template: ImportedTemplate & {
    serverUrl: string
    serverTemplateId: string
    serverNodeId: string | null
    serverVersion: string
    serverTileKeys?: readonly string[]
    wrapX?: boolean
  },
  /** Checked after every awaited step, immediately before the live row may change. */
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  return await writeInOrder(template.id, async () => {
    if (!isCurrent()) return false
    const existing = templates.get(template.id)
    if (existing !== undefined && !isServerTemplate(existing)) {
      throw new RangeError('server template id collides with a local template')
    }
    const visible = existing?.visible ?? isScopeVisible(template.id)
    const preference = existing === undefined ? serverTemplatePreference(template.id) : undefined
    const tiles = new Map<string, TileLevels>()
    if (!isCurrent()) return false
    const priorTileCount = existing?.tiles.size ?? 0
    const priorPixels = existing?.indices.length ?? 0
    const pixelIncrease = template.indices.length - priorPixels
    if (
      retainedIndexPixels + pendingIndexPixels + pixelIncrease > MAX_LOCAL_INDEX_PIXELS ||
      !claimSourceReplacement(priorTileCount, 0)
    ) {
      throw new RangeError('server templates exceed the local rendering budget')
    }
    templates.set(template.id, {
      ...template,
      tiles,
      // Whether someone else's template is on *your* canvas is your decision and nobody else's, so
      // it is read back from this browser's own record rather than defaulted.
      visible,
      everPlaced: true,
      appearance: existing !== undefined ? existing.appearance : (preference?.appearance ?? null),
      revision: existing?.revision ?? 0,
      owns: existing !== undefined ? existing.owns : (preference?.owns ?? []),
      folderId: null,
    })
    retainedIndexPixels += pixelIncrease
    installSourceReplacement(priorTileCount, 0)
    if (existing !== undefined) closeTiles(existing.tiles)
    clearStamped(template.id)
    notify()
    return true
  })
}

/** Refresh server-owned metadata without rebuilding unchanged pixels. */
export const updateServerTemplateMetadata = async (
  id: string,
  name: string,
  serverNodeId: string | null,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || !isServerTemplate(existing)) return false
    if (name.length === 0 || name.length > MAX_TEMPLATE_NAME_LENGTH) return false
    if (existing.name === name && existing.serverNodeId === serverNodeId) return true
    templates.set(id, { ...existing, name, serverNodeId })
    notify()
    return true
  })

/** Drop a server template we hold, because the server has stopped publishing it. */
export const forgetServerTemplate = async (id: string): Promise<void> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || !isServerTemplate(existing)) return
    releaseRetainedTiles(existing.tiles)
    retainedIndexPixels -= existing.indices.length
    desiredVisibility.delete(id)
    clearStamped(id)
    previewOrigins.delete(id)
    templates.delete(id)
    notify()
  })

/**
 * Forget everything one server published, and free the bitmaps with it.
 *
 * For disconnecting. The ordinary sync removes templates a server has stopped publishing, but a
 * disconnected server is never synced again — so its templates stayed in this store forever, drawn
 * on the canvas, belonging to a server that is no longer in the list and with no row anywhere to
 * switch them off from.
 */
export const forgetServerTemplates = async (serverUrl: string): Promise<void> => {
  const ids = [...templates.values()]
    .filter((template) => template.serverUrl === serverUrl)
    .map(({ id }) => id)
  if (ids.length === 0) return
  await writeManyInOrder(ids, async () => {
    let removed = false
    for (const id of ids) {
      const template = templates.get(id)
      if (template === undefined || template.serverUrl !== serverUrl) continue
      releaseRetainedTiles(template.tiles)
      retainedIndexPixels -= template.indices.length
      desiredVisibility.delete(template.id)
      clearStamped(template.id)
      previewOrigins.delete(template.id)
      templates.delete(template.id)
      removed = true
    }
    if (removed) notify()
  })
}

export const addLocalTemplate = async (template: ImportedTemplate): Promise<PlacedTemplate> => {
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  validatePlacement(template)
  if (
    typeof template.id !== 'string' ||
    typeof template.name !== 'string' ||
    template.id.length === 0 ||
    template.id.length > MAX_TEMPLATE_ID_LENGTH ||
    template.name.length > MAX_TEMPLATE_NAME_LENGTH
  ) {
    throw new RangeError('local template metadata is too large')
  }
  if (templates.has(template.id) || pendingAdds.has(template.id)) {
    throw new RangeError('local template id already exists')
  }
  if (
    [...templates.values()].filter((candidate) => !isServerTemplate(candidate)).length +
      pendingAdds.size >=
    MAX_LOCAL_TEMPLATES
  ) {
    throw new RangeError('too many local templates')
  }
  if (retainedIndexPixels + pendingIndexPixels + template.indices.length > MAX_LOCAL_INDEX_PIXELS) {
    throw new RangeError('local templates exceed the persisted pixel budget')
  }
  pendingAdds.add(template.id)
  pendingIndexPixels += template.indices.length
  let tiles: Map<string, TileLevels> | null = null
  try {
    tiles = await slice(template)
    const placed: PlacedTemplate = {
      ...template,
      tiles,
      visible: true,
      everPlaced: false,
      // Follows the global appearance until someone touches this one's own controls.
      appearance: null,
      owns: [],
      revision: 0,
      folderId: null,
    }
    if (!claimSourceReplacement(0, tiles.size)) {
      releaseCandidateTiles(tiles)
      tiles = null
      throw new RangeError('local templates exceed the retained source bitmap budget')
    }
    let revision = 0
    if (!isPendingImage(placed)) {
      const saved = await persist(placed)
      if (saved.status !== 'saved') {
        cancelSourceClaim(0, tiles.size)
        releaseCandidateTiles(tiles)
        tiles = null
        throw new Error('local template could not be saved')
      }
      revision = saved.revision
    }
    installSourceReplacement(0, tiles.size)
    const admitted = { ...placed, revision }
    templates.set(template.id, admitted)
    retainedIndexPixels += template.indices.length
    log('install', `placed ${template.name}`, { tiles: tiles.size })
    notify()
    return admitted
  } finally {
    pendingAdds.delete(template.id)
    pendingIndexPixels -= template.indices.length
  }
}

/**
 * Make a durable local copy without carrying any server-owned identity fields across the boundary.
 *
 * Picking the imported fields explicitly makes a server identity unrepresentable in the copy. An
 * image import is normally pending until its first placement; this copy already has a position, so
 * marking that placement immediately is also what commits it to IndexedDB before its source can be
 * removed. A server source transfers its immutable indices to the Local identity after that commit,
 * so a move at the aggregate pixel budget does not need to retain the same artwork twice.
 */
/** Durable Local placement does not carry the server-only antimeridian representation. */
export const canCopyAsLocalTemplate = (template: PlacedTemplate): boolean =>
  template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS

export const copyAsLocalTemplate = async (
  template: PlacedTemplate,
  id: string,
): Promise<PlacedTemplate> => {
  if (!canCopyAsLocalTemplate(template)) {
    throw new RangeError('wrapped server templates cannot be copied into Local')
  }
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  const imported: ImportedTemplate = {
    id,
    name: template.name,
    source: 'image',
    ...(template.sortOrder === undefined ? {} : { sortOrder: template.sortOrder }),
    originX: template.originX,
    originY: template.originY,
    width: template.width,
    height: template.height,
    indices: template.indices,
    moved: template.moved,
    opaque: template.opaque,
  }
  if (isServerTemplate(template)) {
    validatePlacement(imported)
    if (
      id.length === 0 ||
      id.length > MAX_TEMPLATE_ID_LENGTH ||
      imported.name.length > MAX_TEMPLATE_NAME_LENGTH ||
      templates.has(id) ||
      pendingAdds.has(id)
    ) {
      throw new RangeError('local template metadata or id is unavailable')
    }
    if (
      [...templates.values()].filter((candidate) => !isServerTemplate(candidate)).length +
        pendingAdds.size >=
      MAX_LOCAL_TEMPLATES
    ) {
      throw new RangeError('too many local templates')
    }
    const source = templates.get(template.id)
    if (source !== template) throw new Error('server template changed while it was being copied')
    if (
      retainedIndexPixels - source.indices.length + pendingIndexPixels + imported.indices.length >
      MAX_LOCAL_INDEX_PIXELS
    ) {
      throw new RangeError('local templates exceed the persisted pixel budget')
    }

    pendingAdds.add(id)
    let builtTiles: Map<string, TileLevels> | null = null
    try {
      builtTiles = await slice(imported)
      const tiles = builtTiles
      if (!claimSourceReplacement(template.tiles.size, builtTiles.size)) {
        releaseCandidateTiles(builtTiles)
        builtTiles = null
        throw new RangeError('local templates exceed the retained source bitmap budget')
      }
      const placed: PlacedTemplate = {
        ...imported,
        tiles,
        visible: true,
        everPlaced: true,
        appearance: null,
        owns: [],
        revision: 0,
        folderId: null,
      }
      const saved = await persist(placed)
      if (saved.status !== 'saved') {
        if (builtTiles !== null) {
          cancelSourceClaim(template.tiles.size, builtTiles.size)
          releaseCandidateTiles(builtTiles)
          builtTiles = null
        }
        throw new Error('local template copy could not be saved')
      }
      if (templates.get(template.id) !== source) {
        if (builtTiles !== null) {
          cancelSourceClaim(template.tiles.size, builtTiles.size)
          releaseCandidateTiles(builtTiles)
          builtTiles = null
        }
        await deleteTemplate(id, saved.revision)
        throw new Error('server template changed while it was being copied')
      }

      const copied = { ...placed, revision: saved.revision }
      desiredVisibility.delete(template.id)
      clearStamped(template.id)
      previewOrigins.delete(template.id)
      templates.delete(template.id)
      templates.set(id, copied)
      if (builtTiles !== null) installSourceReplacement(template.tiles.size, builtTiles.size)
      notify()
      return copied
    } finally {
      pendingAdds.delete(id)
    }
  }

  const copied = await addLocalTemplate(imported)
  if (await markPlaced(copied.id)) {
    return templates.get(copied.id) ?? copied
  }
  await removeLocalTemplate(copied.id)
  throw new Error('local template copy could not be saved')
}

/** Rehydrate on startup, before the first frame if possible. */
const restoreStoredTemplates = async (): Promise<void> => {
  let restored = 0
  const seenRevisions = new Map<string, number>()
  let retryAfterGap = false
  let restorePasses = 0
  let remainingCandidates = MAX_RESTORE_CANDIDATES
  let remainingHydratedPixels = MAX_RESTORE_HYDRATED_PIXELS
  do {
    restorePasses++
    retryAfterGap = false
    const remainingTemplates =
      MAX_LOCAL_TEMPLATES -
      [...templates.values()].filter((candidate) => !isServerTemplate(candidate)).length -
      pendingAdds.size
    const remainingPixels = MAX_LOCAL_INDEX_PIXELS - retainedIndexPixels - pendingIndexPixels
    if (
      remainingTemplates <= 0 ||
      remainingPixels <= 0 ||
      remainingCandidates <= 0 ||
      remainingHydratedPixels <= 0
    )
      break
    const stored = await loadTemplates(
      Math.min(remainingTemplates, remainingCandidates),
      Math.min(remainingPixels, remainingHydratedPixels),
      seenRevisions,
    )
    const retryAfterUnavailable = stored.retryAfterUnavailable
    if (
      retryAfterUnavailable !== null &&
      retryAfterUnavailable !== undefined &&
      scheduledRestoreRecovery !== retryAfterUnavailable
    ) {
      scheduledRestoreRecovery = retryAfterUnavailable
      void retryAfterUnavailable.then(() => {
        if (scheduledRestoreRecovery !== retryAfterUnavailable) return
        scheduledRestoreRecovery = null
        const activeRestore = restoreInFlight
        if (activeRestore === null) {
          void restoreLocalTemplates()
          return
        }
        void activeRestore.then(
          () => void restoreLocalTemplates(),
          () => void restoreLocalTemplates(),
        )
      })
    }
    const metrics = stored as Partial<TemplateLoadBatch>
    const batchMetricsAvailable =
      Number.isSafeInteger(metrics.inspected) &&
      Number(metrics.inspected) >= 0 &&
      Number.isSafeInteger(metrics.indexPixels) &&
      Number(metrics.indexPixels) >= 0
    if (batchMetricsAvailable) {
      remainingCandidates = Math.max(0, remainingCandidates - Number(metrics.inspected))
      remainingHydratedPixels = Math.max(0, remainingHydratedPixels - Number(metrics.indexPixels))
    }
    for (const rawTemplate of stored) {
      const hydratedPixels = isTemplateLoadFailure(rawTemplate)
        ? rawTemplate.indexPixels
        : isRecord(rawTemplate) && isUint8Array(rawTemplate.indices)
          ? rawTemplate.indices.length
          : 0
      if (!batchMetricsAvailable) {
        if (remainingCandidates <= 0 || hydratedPixels > remainingHydratedPixels) break
        remainingCandidates--
        remainingHydratedPixels -= hydratedPixels
      }
      if (isTemplateLoadFailure(rawTemplate)) {
        if ('id' in rawTemplate) seenRevisions.set(rawTemplate.id, rawTemplate.revision)
        if (rawTemplate.status === 'invalid') {
          const key = 'id' in rawTemplate ? rawTemplate.id : rawTemplate.key
          const deleted = await deleteTemplate(key, rawTemplate.revision)
          if (deleted.status === 'conflict' && 'id' in rawTemplate) {
            seenRevisions.delete(rawTemplate.id)
          }
        }
        retryAfterGap = true
        continue
      }
      if (isRecord(rawTemplate) && typeof rawTemplate.id === 'string') {
        const revision =
          Number.isSafeInteger(rawTemplate.revision) && Number(rawTemplate.revision) >= 0
            ? Number(rawTemplate.revision)
            : 0
        seenRevisions.set(rawTemplate.id, revision)
      }
      let reserved: StoredTemplate | null = null
      let validated: StoredTemplate | null = null
      try {
        // Earlier builds could persist 0x0, non-finite, out-of-world, or fully transparent records.
        // Validate each independently so one bad legacy entry cannot prevent every good restore.
        let template = normaliseStoredTemplate(rawTemplate)
        if (
          template.folderId !== null &&
          !getState().localFolders.some((folder) => folder.id === template.folderId)
        ) {
          // Folder state and template records live in different stores. Another tab can delete the
          // folder while this record's assignment commits, so no process-local lease can make the two
          // writes atomic. A missing parent has one deterministic recovery: top-level Local, which is
          // also where deleting a folder promises to move its contents.
          const repaired = await saveTemplateFolders([
            { id: template.id, expectedRevision: template.revision, folderId: null },
          ])
          if (repaired.status === 'conflict') {
            seenRevisions.delete(template.id)
            retryAfterGap = true
            continue
          }
          const revision =
            repaired.status === 'saved'
              ? (repaired.revisions.get(template.id) ?? template.revision)
              : template.revision
          if (repaired.status === 'unavailable') {
            warn('install', `could not durably repair missing folder for ${template.name}`)
          }
          template = { ...template, folderId: null, revision }
          seenRevisions.set(template.id, revision)
        }
        if (templates.has(template.id) || pendingAdds.has(template.id)) {
          warn('install', `could not restore ${template.name}: local template id already exists`)
          continue
        }
        if (
          [...templates.values()].filter((candidate) => !isServerTemplate(candidate)).length +
            pendingAdds.size >=
            MAX_LOCAL_TEMPLATES ||
          retainedIndexPixels + pendingIndexPixels + template.indices.length >
            MAX_LOCAL_INDEX_PIXELS
        ) {
          warn('install', `could not restore ${template.name}: persisted pixel budget exhausted`)
          continue
        }
        await validateStoredPixels(template)
        if (template.source === 'image' && !template.everPlaced) {
          throw new RangeError('unfinished image placement')
        }
        validated = template
        // Reserve the ID, cardinality, and index bytes before slicing yields. This also keeps
        // repeated restore calls and any already-running mutations inside the aggregate limits.
        pendingAdds.add(template.id)
        pendingIndexPixels += template.indices.length
        reserved = template
        let visible = template.visible
        let tiles = new Map<string, TileLevels>()
        if (visible) {
          if (retainedSourceTiles + pendingSourceIncrease >= MAX_RETAINED_SOURCE_TILES) {
            visible = false
            warn('install', `restored ${template.name} hidden: source bitmap budget exhausted`)
          } else {
            try {
              const candidate = await slice(template)
              if (claimSourceReplacement(0, candidate.size)) {
                installSourceReplacement(0, candidate.size)
                tiles = candidate
              } else {
                releaseCandidateTiles(candidate)
                visible = false
                warn('install', `restored ${template.name} hidden: source bitmap budget exhausted`)
              }
            } catch (error) {
              visible = false
              warn(
                'install',
                `restored ${template.name} hidden: source rendering unavailable`,
                error,
              )
            }
          }
        }
        templates.set(template.id, {
          ...template,
          appearance: template.appearance ?? null,
          owns: template.owns ?? (template.appearance != null ? APPEARANCE_GROUPS : []),
          folderId: template.folderId ?? null,
          // Keep valid durable records manageable even when this session cannot afford/render their
          // source bitmaps. The durable visibility value remains untouched; an explicit toggle will
          // retry construction and reconcile it.
          visible,
          // Hidden templates cost no bitmap memory. Their palette indices are enough to rebuild the
          // tiles atomically if the user makes them visible again.
          tiles,
        })
        if (visible === template.visible) desiredVisibility.delete(template.id)
        else desiredVisibility.set(template.id, template.visible)
        retainedIndexPixels += template.indices.length
        restored++
      } catch (error) {
        // Validation failures are permanently bad records. Rendering failures are environmental
        // (unsupported canvas, allocation pressure, decoder rejection) and must never destroy data.
        if (validated !== null) {
          warn('install', `could not restore local template ${validated.name}`, String(error))
          continue
        }
        const id =
          isRecord(rawTemplate) && typeof rawTemplate.id === 'string' ? rawTemplate.id : null
        const revision =
          isRecord(rawTemplate) && Number.isSafeInteger(rawTemplate.revision)
            ? (rawTemplate.revision as number)
            : 0
        if (id !== null) {
          const deleted = await deleteTemplate(id, revision)
          if (deleted.status === 'conflict') seenRevisions.delete(id)
          retryAfterGap = true
        }
        warn('install', `discarded invalid local template ${id ?? '(unknown)'}`, String(error))
      } finally {
        if (reserved !== null) {
          pendingAdds.delete(reserved.id)
          pendingIndexPixels -= reserved.indices.length
        }
      }
    }
  } while (retryAfterGap && restorePasses < MAX_LOCAL_TEMPLATES)
  if (restored > 0) log('install', `restored ${restored} local templates`)
  notify()
}

export const restoreLocalTemplates = (): Promise<void> => {
  if (restoreInFlight !== null) return restoreInFlight
  const restoring = restoreStoredTemplates()
  restoreInFlight = restoring
  void restoring.then(
    () => {
      if (restoreInFlight === restoring) restoreInFlight = null
    },
    () => {
      if (restoreInFlight === restoring) restoreInFlight = null
    },
  )
  return restoring
}

interface MoveWaiter {
  readonly resolve: (saved: boolean) => void
  readonly reject: (error: unknown) => void
}

interface MoveTarget {
  readonly originX: number
  readonly originY: number
  readonly everPlaced: boolean
  readonly waiters: readonly MoveWaiter[]
}

interface MoveQueue {
  pending: MoveTarget | null
  running: boolean
}

const moveQueues = new Map<string, MoveQueue>()

const resolveMove = (target: MoveTarget, saved: boolean): void => {
  for (const waiter of target.waiters) waiter.resolve(saved)
}

const rejectMove = (target: MoveTarget, error: unknown): void => {
  for (const waiter of target.waiters) waiter.reject(error)
}

const drainMoves = async (id: string, queue: MoveQueue): Promise<void> => {
  queue.running = true
  while (queue.pending !== null) {
    const target = queue.pending
    queue.pending = null
    const existing = templates.get(id)
    if (existing === undefined) {
      resolveMove(target, false)
      continue
    }
    try {
      const moved = { ...existing, originX: target.originX, originY: target.originY }
      let tiles = existing.visible ? await slice(moved) : new Map<string, TileLevels>()
      // Pointer events can arrive much faster than a tile can be rebuilt. Do not install stale
      // intermediate work; discard it and immediately build only the newest requested position.
      const pendingAfterSlice = queue.pending as MoveTarget | null
      if (pendingAfterSlice !== null) {
        queue.pending = {
          ...pendingAfterSlice,
          everPlaced: target.everPlaced || pendingAfterSlice.everPlaced,
          waiters: [...target.waiters, ...pendingAfterSlice.waiters],
        }
        releaseCandidateTiles(tiles)
        continue
      }
      const current = templates.get(id)
      if (current === undefined || deleting.has(id)) {
        releaseCandidateTiles(tiles)
        resolveMove(target, false)
        continue
      }
      const saved = await writeInOrder(id, async () => {
        const latest = templates.get(id)
        if (latest === undefined || deleting.has(id)) return false
        try {
          validatePlacement(latest, target.originX, target.originY)
        } catch (error) {
          releaseCandidateTiles(tiles)
          tiles = new Map<string, TileLevels>()
          throw error
        }
        const sourceChanged =
          latest.indices !== existing.indices ||
          latest.width !== existing.width ||
          latest.height !== existing.height
        if (sourceChanged) {
          releaseCandidateTiles(tiles)
          tiles = latest.visible
            ? await slice({ ...latest, originX: target.originX, originY: target.originY })
            : new Map<string, TileLevels>()
        }
        if (!latest.visible && tiles.size > 0) {
          releaseCandidateTiles(tiles)
          tiles = new Map<string, TileLevels>()
        }
        if (!latest.visible) {
          await validateStoredPixels({
            ...latest,
            originX: target.originX,
            originY: target.originY,
          })
        }
        if (latest.visible && tiles.size === 0) {
          tiles = await slice({ ...latest, originX: target.originX, originY: target.originY })
        }
        if (!claimSourceReplacement(latest.tiles.size, tiles.size)) return false
        const next = {
          ...latest,
          originX: target.originX,
          originY: target.originY,
          everPlaced: latest.everPlaced || target.everPlaced,
          tiles,
        }
        let revision = latest.revision
        if (!isPendingImage(latest) || target.everPlaced) {
          const result = await savePlaced(next, isPendingImage(latest) ? null : latest.revision)
          const committed = committedRevision(result)
          if (committed === null) {
            cancelSourceClaim(latest.tiles.size, tiles.size)
            if (result.status === 'conflict') {
              releaseCandidateTiles(tiles)
              tiles = new Map<string, TileLevels>()
              await reconcileConflict(id)
            }
            return false
          }
          revision = committed
        }
        clearStamped(id)
        previewOrigins.delete(id)
        templates.set(id, { ...next, revision })
        installSourceReplacement(latest.tiles.size, tiles.size)
        closeTiles(latest.tiles)
        notify()
        return true
      })
      if (!saved) {
        releaseCandidateTiles(tiles)
        warn('install', `move for ${current.name} was not saved`)
      }
      resolveMove(target, saved)
    } catch (error) {
      rejectMove(target, error)
    }
  }
  queue.running = false
  if (queue.pending === null) moveQueues.delete(id)
}

const enqueueMove = async (
  id: string,
  originX: number,
  originY: number,
  everPlaced: boolean,
): Promise<boolean> => {
  const queue = moveQueues.get(id) ?? { pending: null, running: false }
  moveQueues.set(id, queue)
  return await new Promise<boolean>((resolve, reject) => {
    const previous = queue.pending
    queue.pending = {
      originX,
      originY,
      everPlaced: everPlaced || previous?.everPlaced === true,
      waiters: [...(previous?.waiters ?? []), { resolve, reject }],
    }
    if (!queue.running) void drainMoves(id, queue)
  })
}

/** Move a template and re-slice it, coalescing pointer updates so only the latest one wins. */
export const moveLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<boolean> => {
  const existing = templates.get(id)
  if (existing === undefined) return false
  const roundedX = Math.round(originX)
  const roundedY = Math.round(originY)
  validatePlacement(existing, roundedX, roundedY)
  if (existing.originX === roundedX && existing.originY === roundedY && !moveQueues.has(id)) {
    clearLocalPreview(id)
    return true
  }
  return await enqueueMove(id, roundedX, roundedY, false)
}

export const markPlaced = async (id: string): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const next = { ...existing, everPlaced: true }
    const result = await savePlaced(next, isPendingImage(existing) ? null : existing.revision)
    const revision = committedRevision(result)
    if (revision === null) {
      if (result.status === 'conflict') await reconcileConflict(id)
      warn('install', `placement for ${next.name} was not saved`)
      return false
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/** Persist the final origin and first-placement marker in one durable state transition. */
export const placeLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<boolean> => {
  const existing = templates.get(id)
  if (existing === undefined) return false
  const roundedX = Math.round(originX)
  const roundedY = Math.round(originY)
  validatePlacement(existing, roundedX, roundedY)
  if (existing.originX === roundedX && existing.originY === roundedY && !moveQueues.has(id)) {
    clearLocalPreview(id)
    return await markPlaced(id)
  }
  return await enqueueMove(id, roundedX, roundedY, true)
}

/** Move a template into a Local folder, or to the top level with null. */
export const setTemplateFolder = async (id: string, folderId: string | null): Promise<boolean> => {
  const releaseFolder = folderId === null ? null : leaseLocalFolder(folderId)
  if (folderId !== null && releaseFolder === null) return false
  try {
    return await writeInOrder(id, async () => {
      const existing = templates.get(id)
      if (existing === undefined || deleting.has(id)) return false
      if (existing.folderId === folderId) return true
      const next = { ...existing, folderId }
      let revision = existing.revision
      if (!isPendingImage(existing)) {
        const result = await savePlaced(next)
        const committed = committedRevision(result)
        if (committed === null) {
          if (result.status === 'conflict') await reconcileConflict(id)
          warn('install', `folder change for ${next.name} was not saved`)
          return false
        }
        revision = committed
      }
      templates.set(id, { ...next, revision })
      notify()
      return true
    })
  } finally {
    releaseFolder?.()
  }
}

/** Move several local templates together. A failed CAS or IndexedDB write moves none of them. */
export const setTemplatesFolder = async (
  ids: readonly string[],
  folderId: string | null,
): Promise<boolean> => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return true
  const releaseFolder = folderId === null ? null : leaseLocalFolder(folderId)
  if (folderId !== null && releaseFolder === null) return false
  try {
    return await writeManyInOrder(unique, async () => {
      const existing = unique.map((id) => templates.get(id))
      if (existing.some((template) => template === undefined || deleting.has(template.id))) {
        return false
      }
      const present = existing as PlacedTemplate[]
      const changed = present.filter((template) => template.folderId !== folderId)
      if (changed.length === 0) return true
      const durable = changed.filter((template) => !isPendingImage(template))
      const result = await saveTemplateFolders(
        durable.map((template) => ({
          id: template.id,
          expectedRevision: template.revision,
          folderId,
        })),
      )
      if (result.status !== 'saved') {
        if (result.status === 'conflict') {
          for (const template of durable) await reconcileConflict(template.id)
        }
        warn('install', 'folder changes were not saved as one transaction')
        return false
      }
      for (const template of changed) {
        templates.set(template.id, {
          ...template,
          folderId,
          revision: result.revisions.get(template.id) ?? template.revision,
        })
      }
      notify()
      return true
    })
  } finally {
    releaseFolder?.()
  }
}

export const renameLocalTemplate = async (id: string, name: string): Promise<boolean> => {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > MAX_TEMPLATE_NAME_LENGTH) return false
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (trimmed === existing.name) return true
    const next = { ...existing, name: trimmed }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `rename for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/**
 * Whether a delete has been made terminal for this id, from any surface.
 *
 * `deleting` is set synchronously by {@link removeLocalTemplate} and outlives the IndexedDB work,
 * during which the record is still present in `localTemplates()`. A UI that reads only its own
 * "am I deleting this" flag will happily start a move, or offer a second delete, for a template
 * another surface has already condemned.
 */
export const isDeletingLocal = (id: string): boolean => deleting.has(id)

/** In-flight deletions, so a second caller joins the first rather than being told it failed. */
const deletions = new Map<string, Promise<boolean>>()

export const removeLocalTemplate = async (id: string): Promise<boolean> => {
  // A second surface asking for the same deletion is not a failure, and answering `false` made the
  // panel report one over a delete that was succeeding. Join the one already running instead.
  const running = deletions.get(id)
  if (running !== undefined) return await running
  const existing = templates.get(id)
  // Already gone — by this id's own earlier deletion, most likely — which is the outcome asked for.
  if (existing === undefined) return !templates.has(id)
  // Server rows are owned by their remote source. `forgetServerTemplate` is the sync lifecycle;
  // Local deletion must never make one disappear temporarily and then reappear on the next poll.
  if (isServerTemplate(existing)) return false
  if (deleting.has(id)) return false
  if ((deletionLeases.get(id) ?? 0) > 0) return false
  // Terminal immediately: in-flight slices and newly requested mutations must not queue a save
  // behind this delete and resurrect the record.
  deleting.add(id)
  const settled = (async (): Promise<boolean> => {
    // The guard is state, and other surfaces render from it — an open overlay menu locks its controls
    // and shows progress off this. Announcing it only once the record is gone leaves every one of them
    // stale for the whole IndexedDB round trip, and on a static map indefinitely.
    notify()
    let removed = false
    try {
      removed = await writeInOrder(id, async () => {
        const current = templates.get(id)
        if (current === undefined) return true
        if (!isPendingImage(current)) {
          const deleted = await deleteTemplate(id, current.revision)
          if (deleted.status !== 'saved') {
            if (deleted.status === 'conflict') {
              await reconcileConflict(id)
              return !templates.has(id)
            }
            return false
          }
        }
        releaseRetainedTiles(current.tiles)
        retainedIndexPixels -= current.indices.length
        desiredVisibility.delete(id)
        clearStamped(id)
        previewOrigins.delete(id)
        templates.delete(id)
        notify()
        return true
      })
    } finally {
      deleting.delete(id)
      // Clearing it is a state change too. A refused delete otherwise leaves every surface that
      // rendered from the guard locked, with nothing to tell them it lifted.
      if (!removed) notify()
    }
    if (!removed) {
      warn('install', `deletion of ${existing.name} was not saved`)
      return false
    }
    return true
  })()
  deletions.set(id, settled)
  try {
    return await settled
  } finally {
    deletions.delete(id)
  }
}

export const setLocalVisible = async (id: string, visible: boolean): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const desired = desiredVisibility.get(id) ?? existing.visible
    if (existing.visible === visible && desired === visible) return true
    let tiles: ReadonlyMap<string, TileLevels>
    try {
      tiles =
        visible && !isServerTemplate(existing)
          ? await slice(existing)
          : new Map<string, TileLevels>()
    } catch (error) {
      warn('install', `visibility for ${existing.name} could not build source bitmaps`, error)
      return false
    }
    const next = { ...existing, visible, tiles }
    if (deleting.has(id)) {
      if (visible) releaseCandidateTiles(tiles)
      return false
    }
    if (!claimSourceReplacement(existing.tiles.size, tiles.size)) {
      if (visible) releaseCandidateTiles(tiles)
      warn('install', `visibility for ${next.name} exceeds the source bitmap budget`)
      return false
    }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next, existing.revision, visible)
      const committed = committedRevision(result)
      if (committed === null) {
        cancelSourceClaim(existing.tiles.size, tiles.size)
        if (visible) releaseCandidateTiles(tiles)
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `visibility for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    if (isServerTemplate(existing) && !setScopeVisible(id, visible)) {
      cancelSourceClaim(existing.tiles.size, tiles.size)
      if (visible) releaseCandidateTiles(tiles)
      warn('install', `visibility for ${next.name} was not saved`)
      return false
    }
    templates.set(id, { ...next, revision })
    desiredVisibility.delete(id)
    installSourceReplacement(existing.tiles.size, tiles.size)
    closeTiles(existing.tiles)
    clearStamped(id)
    notify()
    return true
  })
}

/** World tiles worth scanning for navigation and mismatch work. */
export const templateTileKeys = (template: PlacedTemplate): Iterable<string> =>
  template.serverTileKeys ?? template.tiles.keys()

/**
 * The level to draw for a given on-screen width.
 *
 * Pick the smallest level still at least as large as the target, so `drawImage` is always
 * *reducing* by less than 2x — the regime where bilinear filtering actually looks like
 * anti-aliasing rather than like sampling noise.
 */
export const levelFor = (tile: TileLevels, targetWidth: number): ImageBitmap => {
  for (let index = tile.levels.length - 1; index >= 0; index--) {
    const level = tile.levels[index]
    if (level !== undefined && level.width >= targetWidth) return level
  }
  return tile.levels[0] as ImageBitmap
}

/** Change how one overlay draws. Appearance never affects slicing, so no re-slice is needed. */
/** Pass null to put the overlay back on the global defaults. */
export const setAppearance = async (
  id: string,
  appearance: Readonly<Partial<Appearance>> | null,
): Promise<boolean> => {
  // Own the request before the ordered write yields, then complete legacy/partial callers from the
  // appearance the template is currently showing. The completed value still goes through the full
  // validator before it can reach IndexedDB.
  const requested: Readonly<Partial<Appearance>> | null =
    appearance === null
      ? null
      : {
          ...appearance,
          ...(appearance.hiddenColours === undefined
            ? {}
            : { hiddenColours: [...appearance.hiddenColours] }),
        }
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const ownedAppearance: Appearance | null =
      requested === null ? null : { ...appearanceOf(existing), ...requested }
    if (ownedAppearance !== null && !isAppearance(ownedAppearance)) return false
    const next = { ...existing, appearance: ownedAppearance }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `appearance for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    const oldFilterKey = appearanceKey(appearanceOf(existing))
    const newFilterKey = appearanceKey(ownedAppearance ?? getState().appearance)
    if (oldFilterKey !== newFilterKey) clearStamped(id)
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/**
 * Take one group over, or hand it back to the defaults.
 *
 * Taking a group over copies the values it is *currently showing* into this template, so nothing
 * moves at the moment of the switch — the overlay looks identical and only stops following. Anything
 * else makes the switch itself an edit, which is a surprise nobody asked for.
 */
export const setOwnsGroup = async (
  id: string,
  group: AppearanceGroup,
  owns: boolean,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (existing.owns.includes(group) === owns) return true
    const next: PlacedTemplate = {
      ...existing,
      appearance: owns ? appearanceOf(existing) : existing.appearance,
      owns: owns ? [...existing.owns, group] : existing.owns.filter((one) => one !== group),
    }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `appearance ownership for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    if (appearanceKey(appearanceOf(existing)) !== appearanceKey(appearanceOf(next)))
      clearStamped(id)
    templates.set(id, { ...next, revision })
    notify()
    return true
  })

/**
 * A tile stamped for one appearance, cached until that appearance changes.
 *
 * Geometry and per-overlay colour filtering decide *what each pixel looks like*, so
 * they belong in the bitmap rather than in a per-frame loop — a 1000x1000 tile is a million pixels
 * and the frame budget is 16ms. `full` needs no stamping at all and returns the mip chain
 * untouched, which is why it costs nothing.
 */
const stamped = new Map<string, { key: string; tile: TileLevels; bytes: number }>()
const pendingStamps = new Map<string, string>()
const MAX_STAMPED_BYTES = 128 * 1024 * 1024
const MAX_CONCURRENT_STAMP_BUILDS = 1
let stampedBytes = 0

interface StampJob {
  readonly build: () => Promise<TileLevels | null>
  readonly resolve: (tile: TileLevels | null) => void
  readonly reject: (error: unknown) => void
}

const stampJobs = new Map<string, StampJob>()
interface StampFailure {
  readonly wanted: string
  readonly attempts: number
  retryAt: number
  retryTimer?: ReturnType<typeof setTimeout>
}
const stampFailures = new Map<string, StampFailure>()
const STAMP_RETRY_BASE_MS = 1_000
const STAMP_RETRY_MAX_MS = 30_000
let activeStampBuilds = 0

const clearStampFailure = (cacheKey: string): void => {
  const failure = stampFailures.get(cacheKey)
  if (failure?.retryTimer !== undefined) clearTimeout(failure.retryTimer)
  stampFailures.delete(cacheKey)
}

const noteStampFailure = (cacheKey: string, wanted: string): void => {
  const previous = stampFailures.get(cacheKey)
  if (previous?.retryTimer !== undefined) clearTimeout(previous.retryTimer)
  const attempts = (previous?.attempts ?? 0) + 1
  const delay = Math.min(STAMP_RETRY_MAX_MS, STAMP_RETRY_BASE_MS * 2 ** (attempts - 1))
  const failure: StampFailure = { wanted, attempts, retryAt: Date.now() + delay }
  failure.retryTimer = setTimeout(() => {
    if (stampFailures.get(cacheKey) !== failure) return
    delete failure.retryTimer
    // setTimeout is monotonic but Date.now can step backwards. Once this timer fires, do not let
    // the wall clock suppress the repaint's retry without scheduling another wake-up.
    failure.retryAt = 0
    notify()
  }, delay)
  stampFailures.set(cacheKey, failure)
}

const pumpStampJobs = (): void => {
  while (activeStampBuilds < MAX_CONCURRENT_STAMP_BUILDS) {
    const queued = stampJobs.entries().next().value as [string, StampJob] | undefined
    if (queued === undefined) return
    const [cacheKey, job] = queued
    stampJobs.delete(cacheKey)
    activeStampBuilds++
    void job
      .build()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeStampBuilds--
        pumpStampJobs()
      })
  }
}

const queueStampBuild = (cacheKey: string, build: StampJob['build']): Promise<TileLevels | null> =>
  new Promise((resolve, reject) => {
    const superseded = stampJobs.get(cacheKey)
    if (superseded !== undefined) superseded.resolve(null)
    stampJobs.set(cacheKey, { build, resolve, reject })
    // Real templates retain at most this many source tiles. Keep the queue under the same hard cap
    // even if callers rapidly replace keys while the sole worker is busy.
    while (stampJobs.size > MAX_RETAINED_SOURCE_TILES) {
      const oldest = stampJobs.entries().next().value as [string, StampJob] | undefined
      if (oldest === undefined) break
      pendingStamps.delete(oldest[0])
      stampJobs.delete(oldest[0])
      oldest[1].resolve(null)
    }
    pumpStampJobs()
  })

const cancelPendingStamp = (cacheKey: string): void => {
  pendingStamps.delete(cacheKey)
  const queued = stampJobs.get(cacheKey)
  if (queued === undefined) return
  stampJobs.delete(cacheKey)
  queued.resolve(null)
}

const cacheStamp = (cacheKey: string, wanted: string, tile: TileLevels): void => {
  const replaced = stamped.get(cacheKey)
  if (replaced !== undefined) {
    stampedBytes -= replaced.bytes
    closeLevels(replaced.tile)
  }
  stamped.delete(cacheKey)
  const bytes = tile.levels.reduce((total, level) => total + level.width * level.height * 4, 0)
  stamped.set(cacheKey, { key: wanted, tile, bytes })
  stampedBytes += bytes
  while (stampedBytes > MAX_STAMPED_BYTES) {
    const oldest = stamped.entries().next().value as
      | [string, { key: string; tile: TileLevels; bytes: number }]
      | undefined
    if (oldest === undefined) break
    stamped.delete(oldest[0])
    stampedBytes -= oldest[1].bytes
    closeLevels(oldest[1].tile)
  }
}

const clearStamped = (id: string): void => {
  const prefix = `${id}|`
  for (const key of pendingStamps.keys()) {
    if (key.startsWith(prefix)) pendingStamps.delete(key)
  }
  for (const [key, job] of stampJobs) {
    if (!key.startsWith(prefix)) continue
    stampJobs.delete(key)
    job.resolve(null)
  }
  for (const key of stampFailures.keys()) {
    if (key.startsWith(prefix)) clearStampFailure(key)
  }
  for (const [key, entry] of stamped) {
    if (!key.startsWith(prefix)) continue
    stampedBytes -= entry.bytes
    closeLevels(entry.tile)
    stamped.delete(key)
  }
}

/**
 * Only the colour filter. Shape is a mask applied at draw time and never re-bakes a tile.
 *
 * This used to include size, rounding, offset and rotation, which meant every drag of every slider
 * rebuilt a million-pixel bitmap per visible tile — with a canvas path per pixel. That is why moving
 * a slider crawled. Colour filtering genuinely does have to be baked, because it changes *which*
 * pixels exist rather than what shape they are, but it changes when someone clicks a swatch and not
 * while they drag.
 */
const appearanceKey = (a: Appearance): string => a.hiddenColours.join(',')

export const stampTile = (
  template: PlacedTemplate,
  tileKey: string,
  requestedAppearance: Readonly<Partial<Appearance>> | null,
  _targetWidth = TILE_SIZE,
): TileLevels | undefined => {
  const source = template.tiles.get(tileKey)
  if (source === undefined) return undefined
  const appearance = { ...appearanceOf(template), ...(requestedAppearance ?? {}) }
  if (!isAppearance(appearance)) return source
  const cacheKey = `${template.id}|${tileKey}`
  if (appearance.hiddenColours.length === 0) {
    cancelPendingStamp(cacheKey)
    clearStampFailure(cacheKey)
    return source
  }
  // Geometry is a draw-time mask. Only the colour filter is baked into this native-size bitmap.
  const wanted = `${template.originX},${template.originY}|${appearanceKey(appearance)}`

  const hit = stamped.get(cacheKey)
  if (hit !== undefined && hit.key === wanted) {
    // Returning to a cached zoom bucket supersedes any replacement for the bucket we just left.
    // Invalidate active work and remove queued work before it can evict this exact match.
    cancelPendingStamp(cacheKey)
    clearStampFailure(cacheKey)
    // Map insertion order is our LRU order.
    stamped.delete(cacheKey)
    stamped.set(cacheKey, hit)
    return hit.tile
  }
  const failure = stampFailures.get(cacheKey)
  // Allocation/decoder failures are environmental rather than zoom-bucket-specific. Carry the
  // backoff across bucket changes so zooming cannot turn one bounded retry into repeated 4–36 MB
  // raster work. A successful build clears the failure immediately.
  const retryBlocked = failure !== undefined && Date.now() < failure.retryAt
  if (!retryBlocked && pendingStamps.get(cacheKey) !== wanted) {
    pendingStamps.set(cacheKey, wanted)
    void queueStampBuild(cacheKey, async () =>
      pendingStamps.get(cacheKey) === wanted
        ? await buildStamp(
            template,
            tileKey,
            appearance,
            () => pendingStamps.get(cacheKey) === wanted,
          )
        : null,
    )
      .then((built) => {
        // A move, removal, appearance change, or zoom-threshold crossing supersedes this work.
        if (pendingStamps.get(cacheKey) !== wanted) {
          if (built !== null) closeLevels(built)
          return
        }
        pendingStamps.delete(cacheKey)
        if (built === null) {
          noteStampFailure(cacheKey, wanted)
          return
        }
        clearStampFailure(cacheKey)
        cacheStamp(cacheKey, wanted, built)
        notify()
      })
      .catch((error: unknown) => {
        if (pendingStamps.get(cacheKey) === wanted) {
          pendingStamps.delete(cacheKey)
          noteStampFailure(cacheKey, wanted)
        }
        warn('draw', `could not build appearance for ${template.name}`, String(error))
      })
  }
  // Showing the unfiltered source while colours are hidden would be incorrect.
  return undefined
}

/**
 * The tile again with hidden colours dropped, written straight into an ImageData.
 *
 * No canvas paths and no upscaling — one pass over the pixels that are actually in this tile. The
 * shape is not this function's business any more.
 */
const buildStamp = async (
  template: PlacedTemplate,
  tileKey: string,
  appearance: Appearance,
  isCurrent: () => boolean,
): Promise<TileLevels | null> => {
  // `async` alone does not defer work before its first await. Yield before allocation and then in
  // bounded row chunks so requesting a new appearance from a frame painter cannot create a long
  // task that freezes MapLibre's next frame.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  if (!isCurrent()) return null
  const [tx, ty] = tileKey.split('/').map(Number)
  if (tx === undefined || ty === undefined) return null
  const hidden = new Set(appearance.hiddenColours)
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  const tileLeft = tx * TILE_SIZE
  const tileTop = ty * TILE_SIZE
  const span = horizontalSpans(template).find(
    (candidate) => candidate.worldStart < tileLeft + TILE_SIZE && candidate.worldEnd > tileLeft,
  )
  if (span === undefined) return null
  const startX = span.sourceStart + Math.max(0, tileLeft - span.worldStart)
  const startY = Math.max(0, tileTop - template.originY)
  const endX =
    span.sourceStart +
    Math.min(span.sourceEnd - span.sourceStart, tileLeft + TILE_SIZE - span.worldStart)
  const endY = Math.min(template.height, tileTop + TILE_SIZE - template.originY)
  for (let y = startY; y < endY; y++) {
    const rowOffset = y * template.width
    const targetRow = (template.originY + y - tileTop) * TILE_SIZE
    for (let x = startX; x < endX; x++) {
      const index = template.indices[rowOffset + x] ?? TRANSPARENT_INDEX
      if (index === TRANSPARENT_INDEX || hidden.has(index)) continue
      const colour = WPLACE_PALETTE[index]
      if (colour === undefined) continue
      const worldX = span.worldStart + x - span.sourceStart
      const target = (targetRow + (worldX - tileLeft)) * 4
      rgba[target] = colour.rgb[0]
      rgba[target + 1] = colour.rgb[1]
      rgba[target + 2] = colour.rgb[2]
      rgba[target + 3] = 255
    }
    if ((y - startY + 1) % 64 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (!isCurrent()) return null
    }
  }
  if (!isCurrent()) return null
  const bitmap = await createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE))
  if (!isCurrent()) {
    bitmap.close()
    return null
  }
  return { levels: [bitmap] }
}

/**
 * A template as an indexed PNG, ready to upload.
 *
 * The server quantises on ingest anyway, but sending the already-quantised pixels means what was
 * previewed locally is byte-identical to what is stored — no second opinion from a second
 * quantiser on the way through.
 */
export const templateAsPng = async (template: PlacedTemplate): Promise<Blob | null> => {
  if (!isCurrentTemplate(template)) return null
  const encoded = await encodeIndexedPng(template.width, template.height, template.indices)
  if (!isCurrentTemplate(template)) return null
  return new Blob([Uint8Array.from(encoded)], { type: 'image/png' })
}
