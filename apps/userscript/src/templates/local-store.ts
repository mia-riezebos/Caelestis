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
import { deleteTemplate, loadTemplates, type StoredTemplate, saveTemplate } from './persist.js'

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
}

const templates = new Map<string, PlacedTemplate>()
const previewOrigins = new Map<string, { x: number; y: number }>()
const deleting = new Set<string>()
const pendingAdds = new Set<string>()
const listeners: Array<() => void> = []
const MAX_LOCAL_TEMPLATES = 64
const MAX_LOCAL_INDEX_PIXELS = 64 * 1024 * 1024
let retainedIndexPixels = 0
let pendingIndexPixels = 0

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
  } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TEMPLATE_ID_LENGTH) {
    throw new RangeError('template id is invalid')
  }
  if (typeof name !== 'string' || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new RangeError('template name is invalid')
  }
  if (!['wplace', 'marble', 'image'].includes(String(source))) {
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
    appearance: normaliseAppearance(appearance),
    ...(sortOrder === undefined ? {} : { sortOrder: sortOrder as number }),
  }
  validatePlacement(normalised)
  return normalised
}

const validateStoredPixels = async (template: StoredTemplate): Promise<void> => {
  let opaque = 0
  for (let pixel = 0; pixel < template.indices.length; pixel++) {
    const index = template.indices[pixel] ?? TRANSPARENT_INDEX
    if (index !== TRANSPARENT_INDEX) {
      if (index >= WPLACE_PALETTE.length) throw new RangeError('template palette index is invalid')
      opaque++
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

const writeTails = new Map<string, Promise<boolean>>()

const writeInOrder = (id: string, write: () => Promise<boolean>): Promise<boolean> => {
  const previous = writeTails.get(id) ?? Promise.resolve(true)
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

const persist = async (placed: PlacedTemplate): Promise<boolean> => {
  const { tiles: _tiles, ...rest } = placed
  return await writeInOrder(placed.id, async () => await saveTemplate(rest))
}

const savePlaced = async (placed: PlacedTemplate): Promise<boolean> => {
  const { tiles: _tiles, ...rest } = placed
  return await saveTemplate(rest)
}

export const addLocalTemplate = async (template: ImportedTemplate): Promise<PlacedTemplate> => {
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
    }
    if (!claimSourceReplacement(0, tiles.size)) {
      releaseCandidateTiles(tiles)
      tiles = null
      throw new RangeError('local templates exceed the retained source bitmap budget')
    }
    if (!(await persist(placed))) {
      cancelSourceClaim(0, tiles.size)
      releaseCandidateTiles(tiles)
      tiles = null
      throw new Error('local template could not be saved')
    }
    installSourceReplacement(0, tiles.size)
    templates.set(template.id, placed)
    retainedIndexPixels += template.indices.length
    log('install', `placed ${template.name}`, { tiles: tiles.size })
    notify()
    return placed
  } finally {
    pendingAdds.delete(template.id)
    pendingIndexPixels -= template.indices.length
  }
}

/** Rehydrate on startup, before the first frame if possible. */
export const restoreLocalTemplates = async (): Promise<void> => {
  const stored = await loadTemplates(MAX_LOCAL_TEMPLATES, MAX_LOCAL_INDEX_PIXELS)
  let restored = 0
  for (const rawTemplate of stored) {
    let reserved: StoredTemplate | null = null
    let validated: StoredTemplate | null = null
    try {
      // Earlier builds could persist 0x0, non-finite, out-of-world, or fully transparent records.
      // Validate each independently so one bad legacy entry cannot prevent every good restore.
      const template = normaliseStoredTemplate(rawTemplate)
      await validateStoredPixels(template)
      if (template.source === 'image' && !template.everPlaced) {
        throw new RangeError('unfinished image placement')
      }
      validated = template
      if (templates.has(template.id) || pendingAdds.has(template.id)) {
        warn('install', `could not restore ${template.name}: local template id already exists`)
        continue
      }
      if (
        templates.size + pendingAdds.size >= MAX_LOCAL_TEMPLATES ||
        retainedIndexPixels + pendingIndexPixels + template.indices.length > MAX_LOCAL_INDEX_PIXELS
      ) {
        warn('install', `could not restore ${template.name}: persisted pixel budget exhausted`)
        continue
      }
      // Reserve the ID, cardinality, and index bytes before slicing yields. Imports can begin while
      // startup restore is in flight and must observe the same aggregate limits.
      pendingAdds.add(template.id)
      pendingIndexPixels += template.indices.length
      reserved = template
      const tiles = template.visible ? await slice(template) : new Map<string, TileLevels>()
      if (!claimSourceReplacement(0, tiles.size)) {
        releaseCandidateTiles(tiles)
        warn('install', `could not restore ${template.name}: source bitmap budget exhausted`)
        continue
      }
      installSourceReplacement(0, tiles.size)
      templates.set(template.id, {
        appearance: DEFAULT_APPEARANCE,
        ...template,
        // Hidden templates cost no bitmap memory. Their palette indices are enough to rebuild the
        // tiles atomically if the user makes them visible again.
        tiles,
      })
      retainedIndexPixels += template.indices.length
      restored++
    } catch (error) {
      // Validation failures are permanently bad records. Rendering failures are environmental
      // (unsupported canvas, allocation pressure, decoder rejection) and must never destroy data.
      if (validated !== null) {
        warn('install', `could not restore local template ${validated.name}`, String(error))
        continue
      }
      try {
        const template = normaliseStoredTemplate(rawTemplate)
        await validateStoredPixels(template)
        if (template.source === 'image' && !template.everPlaced) {
          throw new RangeError('unfinished image placement')
        }
        warn('install', `could not restore local template ${template.name}`, String(error))
      } catch (validationError) {
        const id =
          isRecord(rawTemplate) && typeof rawTemplate.id === 'string' ? rawTemplate.id : null
        if (id !== null) await deleteTemplate(id)
        warn(
          'install',
          `discarded invalid local template ${id ?? '(unknown)'}`,
          String(validationError),
        )
      }
    } finally {
      if (reserved !== null) {
        pendingAdds.delete(reserved.id)
        pendingIndexPixels -= reserved.indices.length
      }
    }
  }
  if (restored > 0) log('install', `restored ${restored} local templates`)
  notify()
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
      clearStamped(id)
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
        if (!(await savePlaced(next))) {
          cancelSourceClaim(latest.tiles.size, tiles.size)
          return false
        }
        clearStamped(id)
        previewOrigins.delete(id)
        templates.set(id, next)
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
  if (existing.originX === roundedX && existing.originY === roundedY) {
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
    if (!(await savePlaced(next))) {
      warn('install', `placement for ${next.name} was not saved`)
      return false
    }
    templates.set(id, next)
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
  if (existing.originX === roundedX && existing.originY === roundedY) {
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
  const removed = await writeInOrder(id, async () => {
    const current = templates.get(id)
    if (current === undefined) return false
    if (!(await deleteTemplate(id))) return false
    releaseRetainedTiles(current.tiles)
    retainedIndexPixels -= current.indices.length
    clearStamped(id)
    previewOrigins.delete(id)
    templates.delete(id)
    notify()
    return true
  })
  if (!removed) {
    deleting.delete(id)
    warn('install', `deletion of ${existing.name} was not saved`)
    return false
  }
  deleting.delete(id)
  return true
}

export const setLocalVisible = async (id: string, visible: boolean): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (existing.visible === visible) return true
    const tiles = visible ? await slice(existing) : new Map<string, TileLevels>()
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
    if (!(await savePlaced(next))) {
      cancelSourceClaim(existing.tiles.size, tiles.size)
      if (visible) releaseCandidateTiles(tiles)
      warn('install', `visibility for ${next.name} was not saved`)
      return false
    }
    templates.set(id, next)
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
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const next = { ...existing, appearance }
    if (!(await savePlaced(next))) {
      warn('install', `appearance for ${next.name} was not saved`)
      return false
    }
    if (appearanceKey(existing.appearance) !== appearanceKey(appearance)) clearStamped(id)
    templates.set(id, next)
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
const MAX_RETAINED_STAMP_WIDTH = 1_500
const MAX_CONCURRENT_STAMP_BUILDS = 1
let stampedBytes = 0

interface StampJob {
  readonly build: () => Promise<TileLevels | null>
  readonly resolve: (tile: TileLevels | null) => void
  readonly reject: (error: unknown) => void
}

const stampJobs = new Map<string, StampJob>()
let activeStampBuilds = 0

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
      stampJobs.delete(oldest[0])
      oldest[1].resolve(null)
    }
    pumpStampJobs()
  })

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
  // A 3000px level is 36 MB and a normal viewport needs several. Retaining the 1500px level and
  // magnifying it with nearest-neighbour preserves crisp shapes without an eviction/rebuild loop.
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
  const wanted = `${template.originX},${template.originY}|${appearanceKey(renderedAppearance)}|${wantedWidth}`
  if (renderedAppearance.shape === 'full' && renderedAppearance.hiddenColours.length === 0)
    return source

  const cacheKey = `${template.id}|${tileKey}`
  const hit = stamped.get(cacheKey)
  if (hit !== undefined && hit.key === wanted) {
    // Map insertion order is our LRU order.
    stamped.delete(cacheKey)
    stamped.set(cacheKey, hit)
    return hit.tile
  }
  if (pendingStamps.get(cacheKey) !== wanted) {
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
        if (built === null) return
        cacheStamp(cacheKey, wanted, built)
        notify()
      })
      .catch((error: unknown) => {
        if (pendingStamps.get(cacheKey) === wanted) pendingStamps.delete(cacheKey)
        warn('draw', `could not build appearance for ${template.name}`, String(error))
      })
  }
  // Keep the previous full raster visible while shape-only work is prepared. When colours are
  // hidden, showing the unfiltered source would be incorrect, so skip this tile for one repaint.
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
      if (context === null) break
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
