import {
  encodeIndexedPng,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
  WPLACE_PALETTE,
} from '@wts/shared'
import { log, warn } from '../debug.js'
import { isUint8Array, pageWindow } from '../page-world.js'
import { type Appearance, anchorOffset, DEFAULT_APPEARANCE, scaleFor } from './appearance.js'
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
  type TemplateLoadBatch,
  type TemplateLoadFailure,
} from './persist.js'

/**
 * Local templates, and the per-tile bitmaps the overlay actually draws.
 *
 * The renderer runs every frame and must not do per-pixel work there, so each template is sliced
 * once into one `ImageBitmap` per tile it touches. Drawing then costs one `drawImage` per visible
 * tile, whatever the template's size — which is what keeps a 1612x2584 import from costing anything
 * per frame.
 *
 * Re-slicing happens only when a template moves, which is a drag, not a frame.
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
  /** Keyed `x/y`; only tiles the template actually covers appear. */
  readonly tiles: ReadonlyMap<string, TileLevels>
  readonly visible: boolean
  /**
   * Whether a placement has ever been applied to this template.
   *
   * A freshly imported image has never been anywhere, so cancelling its first placement should
   * remove it rather than leave it stranded at a position nobody chose.
   */
  readonly everPlaced: boolean
  /** How this one is drawn. Per-overlay, because the right opacity for a dense mural and a thin
   *  outline are not the same number. */
  readonly appearance: Appearance
  /** IndexedDB compare-and-swap token; not part of template identity or rendering. */
  readonly revision: number
}

const templates = new Map<string, PlacedTemplate>()
// Effective visibility can temporarily differ from durable user intent when source bitmap
// construction is unavailable. Keep that intent out of the public render model, but preserve it
// across unrelated writes and cross-tab reconciliation.
const desiredVisibility = new Map<string, boolean>()
const reconciliationObservers = new Map<string, Set<() => void>>()
const previewOrigins = new Map<string, { x: number; y: number }>()
const deleting = new Set<string>()
const pendingAdds = new Set<string>()
const listeners: Array<() => void> = []
const MAX_LOCAL_TEMPLATES = 64
const MAX_LOCAL_INDEX_PIXELS = 64 * 1024 * 1024
const MAX_RESTORE_CANDIDATES = MAX_LOCAL_TEMPLATES * 4
const MAX_RESTORE_HYDRATED_PIXELS = MAX_LOCAL_INDEX_PIXELS * 2
let retainedIndexPixels = 0
let pendingIndexPixels = 0
let restoreInFlight: Promise<void> | null = null
let scheduledRestoreRecovery: Promise<void> | null = null
let reconciliationTail: Promise<void> = Promise.resolve()

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

const orderedTemplates = (): PlacedTemplate[] =>
  [...templates.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))

export const onLocalChange = (listener: () => void): void => {
  listeners.push(listener)
}
const notify = (): void => {
  // Mirror a summary onto the window so the dev harness can assert on placement without reaching
  // into module state. Metadata only — never the pixels.
  try {
    ;(pageWindow() as unknown as Record<string, unknown>).__wtsLocal = orderedTemplates().map(
      (t) => ({
        id: t.id,
        name: t.name,
        source: t.source,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
        tiles: t.tiles.size,
      }),
    )
  } catch (error) {
    try {
      warn('install', 'could not update local template diagnostics', String(error))
    } catch {}
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      try {
        warn('install', 'local template listener failed', String(error))
      } catch {}
    }
  }
}

export const localTemplates = (): readonly PlacedTemplate[] => orderedTemplates()

/** Transient placement never touches IndexedDB or rebuilds tiles; the renderer translates them. */
export const previewLocalTemplate = (id: string, originX: number, originY: number): boolean => {
  const existing = templates.get(id)
  if (existing === undefined || deleting.has(id)) return false
  const x = Math.round(originX)
  const y = Math.round(originY)
  validatePlacement(existing, x, y)
  previewOrigins.set(id, { x, y })
  notify()
  return true
}

export const previewOriginFor = (id: string): { x: number; y: number } | null =>
  previewOrigins.get(id) ?? null

export const clearLocalPreview = (id: string): boolean => {
  if (!previewOrigins.delete(id)) return templates.has(id)
  notify()
  return true
}

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
  if (originX + template.width > WORLD_PIXELS)
    throw new RangeError('template runs past the east edge')
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
  const { shape, size, anchor, opacity, hiddenColours } = value
  return (
    typeof shape === 'string' &&
    ['full', 'square', 'circle', 'triangle'].includes(shape) &&
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= 0 &&
    size <= 1 &&
    typeof anchor === 'string' &&
    ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'].includes(anchor) &&
    typeof opacity === 'number' &&
    Number.isFinite(opacity) &&
    opacity >= 0 &&
    opacity <= 1 &&
    Array.isArray(hiddenColours) &&
    hiddenColours.length <= WPLACE_PALETTE.length &&
    hiddenColours.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < WPLACE_PALETTE.length,
    ) &&
    new Set(hiddenColours).size === hiddenColours.length
  )
}

const normaliseAppearance = (value: unknown): Appearance => {
  if (!isAppearance(value)) return DEFAULT_APPEARANCE
  return { ...value, hiddenColours: [...value.hiddenColours] }
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
    revision,
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
    appearance: normaliseAppearance(appearance),
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

const slice = async (template: ImportedTemplate): Promise<Map<string, TileLevels>> => {
  validatePlacement(template)
  await yieldToBrowser()
  const firstTileX = Math.floor(template.originX / TILE_SIZE)
  const firstTileY = Math.floor(template.originY / TILE_SIZE)
  const lastTileX = Math.floor((template.originX + template.width - 1) / TILE_SIZE)
  const lastTileY = Math.floor((template.originY + template.height - 1) / TILE_SIZE)

  const out = new Map<string, TileLevels>()
  let scanWork = 0
  try {
    for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
      for (let tileX = firstTileX; tileX <= lastTileX; tileX++) {
        // Allocate a full tile only once a painted source pixel is found. Sparse Marble extents can
        // cross thousands of empty tile rows; eagerly allocating 4 MB for every empty tile turns a
        // small valid import into gigabytes of allocation churn.
        let rgba: Uint8ClampedArray<ArrayBuffer> | null = null
        const tileLeft = tileX * TILE_SIZE
        const tileTop = tileY * TILE_SIZE
        const startX = Math.max(0, tileLeft - template.originX)
        const startY = Math.max(0, tileTop - template.originY)
        const endX = Math.min(template.width, tileLeft + TILE_SIZE - template.originX)
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
            const target = (targetRow + (template.originX + x - tileLeft)) * 4
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

const persist = async (placed: PlacedTemplate): Promise<SaveResult> => {
  const { tiles: _tiles, ...rest } = placed
  return await writeInOrder(placed.id, async () => await saveTemplate(rest, null))
}

const savePlaced = async (
  placed: PlacedTemplate,
  expectedRevision: number | null = placed.revision,
  visible: boolean = desiredVisibility.get(placed.id) ?? placed.visible,
): Promise<SaveResult> => {
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
        appearance: DEFAULT_APPEARANCE,
        ...winner,
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
  if (templates.size + pendingAdds.size >= MAX_LOCAL_TEMPLATES) {
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
      appearance: DEFAULT_APPEARANCE,
      revision: 0,
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
    const remainingTemplates = MAX_LOCAL_TEMPLATES - templates.size - pendingAdds.size
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
        const template = normaliseStoredTemplate(rawTemplate)
        if (templates.has(template.id) || pendingAdds.has(template.id)) {
          warn('install', `could not restore ${template.name}: local template id already exists`)
          continue
        }
        if (
          templates.size + pendingAdds.size >= MAX_LOCAL_TEMPLATES ||
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
          appearance: DEFAULT_APPEARANCE,
          ...template,
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
        if (!latest.visible && tiles.size > 0) {
          releaseCandidateTiles(tiles)
          tiles = new Map<string, TileLevels>()
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

export const removeLocalTemplate = async (id: string): Promise<boolean> => {
  const existing = templates.get(id)
  if (existing === undefined || deleting.has(id)) return false
  // Terminal immediately: in-flight slices and newly requested mutations must not queue a save
  // behind this delete and resurrect the record.
  deleting.add(id)
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
  }
  if (!removed) {
    warn('install', `deletion of ${existing.name} was not saved`)
    return false
  }
  return true
}

export const setLocalVisible = async (id: string, visible: boolean): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const desired = desiredVisibility.get(id) ?? existing.visible
    if (existing.visible === visible && desired === visible) return true
    let tiles: ReadonlyMap<string, TileLevels>
    try {
      tiles = visible ? await slice(existing) : new Map<string, TileLevels>()
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
    templates.set(id, { ...next, revision })
    desiredVisibility.delete(id)
    installSourceReplacement(existing.tiles.size, tiles.size)
    closeTiles(existing.tiles)
    clearStamped(id)
    notify()
    return true
  })
}

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
export const setAppearance = async (id: string, appearance: Appearance): Promise<boolean> => {
  if (!isAppearance(appearance)) return false
  // The write starts in a later microtask. Own the validated data now so the caller cannot mutate
  // its array after validation and smuggle invalid or unbounded state into IndexedDB.
  const ownedAppearance: Appearance = {
    ...appearance,
    hiddenColours: [...appearance.hiddenColours],
  }
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
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
    if (appearanceKey(existing.appearance) !== appearanceKey(ownedAppearance)) clearStamped(id)
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/**
 * A tile stamped for one appearance, cached until that appearance changes.
 *
 * Shape, size, anchor and per-overlay colour filtering all decide *what each pixel looks like*, so
 * they belong in the bitmap rather than in a per-frame loop — a 1000x1000 tile is a million pixels
 * and the frame budget is 16ms. `full` needs no stamping at all and returns the mip chain
 * untouched, which is why it costs nothing.
 */
const stamped = new Map<string, { key: string; tile: TileLevels; bytes: number }>()
const pendingStamps = new Map<string, string>()
const MAX_STAMPED_BYTES = 128 * 1024 * 1024
// Every retained source tile can need a shaped stamp in the same viewport. Size a stamp so the
// complete legitimate working set fits: otherwise the last build evicts the first, its repaint
// immediately rebuilds it, and a static view never quiesces.
const MAX_RETAINED_STAMP_WIDTH = Math.floor(
  Math.sqrt(MAX_STAMPED_BYTES / (4 * MAX_RETAINED_SOURCE_TILES)),
)
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
  const attempts = previous?.wanted === wanted ? previous.attempts + 1 : 1
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

const appearanceKey = (a: Appearance): string =>
  `${a.shape}|${a.size}|${a.anchor}|${a.hiddenColours.join(',')}`

const desiredLevelWidth = (fullWidth: number, targetWidth: number): number => {
  let width = fullWidth
  while (width > MIN_MIP_SIZE) {
    const next = Math.max(1, Math.floor(width / 2))
    if (next < targetWidth) break
    width = next
  }
  // Magnifying a bounded level with nearest-neighbour preserves crisp shapes while guaranteeing
  // that the complete retained source-tile working set cannot enter an eviction/rebuild loop.
  return Math.min(width, MAX_RETAINED_STAMP_WIDTH)
}

export const stampTile = (
  template: PlacedTemplate,
  tileKey: string,
  appearance: Appearance,
  targetWidth = TILE_SIZE,
): TileLevels | undefined => {
  const source = template.tiles.get(tileKey)
  if (source === undefined) return undefined
  // Sub-pixel geometry conveys nothing below one screen pixel per source pixel. At that scale use a
  // native-size filtered raster: colour toggles still apply, without paying 36 MB for a 3x tile.
  const renderedAppearance =
    targetWidth < TILE_SIZE && appearance.shape !== 'full'
      ? { ...appearance, shape: 'full' as const }
      : appearance
  // Opacity is applied at draw time, so it is deliberately not part of the cache key — dragging
  // that slider must not rebuild a million pixels per frame.
  const wantedWidth = desiredLevelWidth(TILE_SIZE * scaleFor(renderedAppearance), targetWidth)
  const identity = `${template.originX},${template.originY}|${appearanceKey(renderedAppearance)}`
  const wanted = `${identity}|${wantedWidth}`
  const cacheKey = `${template.id}|${tileKey}`
  if (renderedAppearance.shape === 'full' && renderedAppearance.hiddenColours.length === 0) {
    cancelPendingStamp(cacheKey)
    clearStampFailure(cacheKey)
    return source
  }

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
  if (failure !== undefined && failure.wanted !== wanted) clearStampFailure(cacheKey)
  const retryBlocked = failure?.wanted === wanted && Date.now() < failure.retryAt
  if (!retryBlocked && pendingStamps.get(cacheKey) !== wanted) {
    pendingStamps.set(cacheKey, wanted)
    void queueStampBuild(cacheKey, async () =>
      pendingStamps.get(cacheKey) === wanted
        ? await buildStamp(
            template,
            tileKey,
            renderedAppearance,
            wantedWidth,
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
  // A stamp with the same identity has the right geometry and colour filtering at another mip.
  // Keep it visible while the requested zoom bucket is built instead of blinking the tile out.
  if (hit?.key.startsWith(`${identity}|`)) {
    stamped.delete(cacheKey)
    stamped.set(cacheKey, hit)
    return hit.tile
  }
  // Keep the source visible while shape-only work is prepared. When colours are hidden, showing
  // the unfiltered source would be incorrect, so the first filtered build has no safe fallback.
  return renderedAppearance.hiddenColours.length === 0 ? source : undefined
}

const stampMask = (appearance: Appearance, scale: number): Uint8ClampedArray | null => {
  if (appearance.shape === 'full') return new Uint8ClampedArray([0, 0, 0, 255])
  const canvas = new OffscreenCanvas(scale, scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  const side = appearance.size * scale
  const offset = anchorOffset(appearance.anchor, appearance.size)
  const px = offset.x * scale
  const py = offset.y * scale
  context.fillStyle = '#ffffff'
  if (appearance.shape === 'circle') {
    context.beginPath()
    context.arc(px + side / 2, py + side / 2, side / 2, 0, Math.PI * 2)
    context.fill()
  } else if (appearance.shape === 'triangle') {
    context.beginPath()
    context.moveTo(px, py)
    context.lineTo(px + side, py)
    context.lineTo(px, py + side)
    context.closePath()
    context.fill()
  } else {
    context.fillRect(px, py, side, side)
  }
  return context.getImageData(0, 0, scale, scale).data
}

const buildStamp = async (
  template: PlacedTemplate,
  tileKey: string,
  appearance: Appearance,
  wantedWidth: number,
  isCurrent: () => boolean,
): Promise<TileLevels | null> => {
  // `async` alone does not defer work before its first await. Yield before allocation and then in
  // bounded row chunks so requesting a new appearance from a frame painter cannot create a long
  // task that freezes MapLibre's next frame.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  if (!isCurrent()) return null
  const [tx, ty] = tileKey.split('/').map(Number)
  if (tx === undefined || ty === undefined) return null
  const scale = scaleFor(appearance)
  const size = TILE_SIZE * scale
  const mask = stampMask(appearance, scale)
  if (mask === null) return null
  const rgba = new Uint8ClampedArray(size * size * 4)

  const hidden = new Set(appearance.hiddenColours)
  const tileLeft = tx * TILE_SIZE
  const tileTop = ty * TILE_SIZE
  const startX = Math.max(0, tileLeft - template.originX)
  const startY = Math.max(0, tileTop - template.originY)
  const endX = Math.min(template.width, tileLeft + TILE_SIZE - template.originX)
  const endY = Math.min(template.height, tileTop + TILE_SIZE - template.originY)

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const index = template.indices[y * template.width + x] ?? TRANSPARENT_INDEX
      if (index === TRANSPARENT_INDEX || hidden.has(index)) continue
      const colour = WPLACE_PALETTE[index]
      if (colour === undefined) continue
      const cellX = (template.originX + x - tileLeft) * scale
      const cellY = (template.originY + y - tileTop) * scale
      for (let maskY = 0; maskY < scale; maskY++) {
        for (let maskX = 0; maskX < scale; maskX++) {
          const alpha = mask[(maskY * scale + maskX) * 4 + 3] ?? 0
          if (alpha === 0) continue
          const target = ((cellY + maskY) * size + cellX + maskX) * 4
          rgba[target] = colour.rgb[0]
          rgba[target + 1] = colour.rgb[1]
          rgba[target + 2] = colour.rgb[2]
          rgba[target + 3] = alpha
        }
      }
    }
    if ((y - startY + 1) % 64 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (!isCurrent()) return null
    }
  }
  if (!isCurrent()) return null
  let current: ImageBitmap | null = null
  try {
    current = await createImageBitmap(new ImageData(rgba, size, size))
    if (!isCurrent()) {
      current.close()
      return null
    }
    let width = size
    while (width > wantedWidth) {
      const nextWidth = Math.max(wantedWidth, Math.floor(width / 2))
      const canvas = new OffscreenCanvas(nextWidth, nextWidth)
      const context = canvas.getContext('2d')
      if (context === null) {
        current.close()
        return null
      }
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(current, 0, 0, nextWidth, nextWidth)
      const next = await createImageBitmap(canvas)
      current.close()
      current = next
      if (!isCurrent()) {
        current.close()
        return null
      }
      width = nextWidth
    }
    return { levels: [current] }
  } catch (error) {
    current?.close()
    throw error
  }
}

/**
 * A template as an indexed PNG, ready to upload.
 *
 * The server quantises on ingest anyway, but sending the already-quantised pixels means what was
 * previewed locally is byte-identical to what is stored — no second opinion from a second
 * quantiser on the way through.
 */
export const templateAsPng = async (template: PlacedTemplate): Promise<Blob | null> => {
  const encoded = await encodeIndexedPng(template.width, template.height, template.indices)
  return new Blob([Uint8Array.from(encoded)], { type: 'image/png' })
}
