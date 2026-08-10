import { TILE_SIZE, TRANSPARENT_INDEX, WORLD_PIXELS, WPLACE_PALETTE } from '@wts/shared'
import { log, warn } from '../debug.js'
import { type Appearance, anchorOffset, DEFAULT_APPEARANCE, scaleFor } from './appearance.js'
import type { ImportedTemplate } from './import.js'
import { deleteTemplate, loadTemplates, saveTemplate } from './persist.js'

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
const listeners: Array<() => void> = []

export const onLocalChange = (listener: () => void): void => {
  listeners.push(listener)
}
const notify = (): void => {
  // Mirror a summary onto the window so the dev harness can assert on placement without reaching
  // into module state. Metadata only — never the pixels.
  ;(window as unknown as Record<string, unknown>).__wtsLocal = [...templates.values()].map((t) => ({
    id: t.id,
    name: t.name,
    source: t.source,
    originX: t.originX,
    originY: t.originY,
    width: t.width,
    height: t.height,
    tiles: t.tiles.size,
  }))
  for (const listener of listeners) listener()
}

export const localTemplates = (): readonly PlacedTemplate[] => [...templates.values()]

/**
 * Slice a template into tile-sized bitmaps.
 *
 * Transparent tiles are dropped rather than stored empty: a template with a sparse bounding box
 * otherwise pays for every tile in that box on every frame, and most large templates are sparse.
 */
/** Halve until small, so any on-screen size has a source within 2x of it. */
const MIN_MIP_SIZE = 125

const closeLevels = (tile: TileLevels): void => {
  for (const level of tile.levels) level.close()
}

const closeTiles = (tiles: ReadonlyMap<string, TileLevels>): void => {
  for (const tile of tiles.values()) closeLevels(tile)
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

const slice = async (template: ImportedTemplate): Promise<Map<string, TileLevels>> => {
  validatePlacement(template)
  const firstTileX = Math.floor(template.originX / TILE_SIZE)
  const firstTileY = Math.floor(template.originY / TILE_SIZE)
  const lastTileX = Math.floor((template.originX + template.width - 1) / TILE_SIZE)
  const lastTileY = Math.floor((template.originY + template.height - 1) / TILE_SIZE)

  const out = new Map<string, TileLevels>()
  try {
    for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
      for (let tileX = firstTileX; tileX <= lastTileX; tileX++) {
        const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
        let painted = 0
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
            const target = (targetRow + (template.originX + x - tileLeft)) * 4
            rgba[target] = colour.rgb[0]
            rgba[target + 1] = colour.rgb[1]
            rgba[target + 2] = colour.rgb[2]
            rgba[target + 3] = 255
            painted++
          }
        }
        if (painted === 0) continue
        out.set(`${tileX}/${tileY}`, {
          levels: await buildLevels(new ImageData(rgba, TILE_SIZE, TILE_SIZE)),
        })
      }
    }
    return out
  } catch (error) {
    closeTiles(out)
    throw error
  }
}

const writeTails = new Map<string, Promise<boolean>>()

const writeInOrder = (id: string, write: () => Promise<boolean>): Promise<boolean> => {
  const previous = writeTails.get(id) ?? Promise.resolve(true)
  const next = previous.then(write, write)
  writeTails.set(id, next)
  void next.finally(() => {
    if (writeTails.get(id) === next) writeTails.delete(id)
  })
  return next
}

const persist = async (placed: PlacedTemplate): Promise<boolean> => {
  const { tiles: _tiles, ...rest } = placed
  return await writeInOrder(placed.id, async () => await saveTemplate(rest))
}

export const addLocalTemplate = async (template: ImportedTemplate): Promise<PlacedTemplate> => {
  validatePlacement(template)
  const tiles = await slice(template)
  const placed: PlacedTemplate = {
    ...template,
    tiles,
    visible: true,
    everPlaced: false,
    appearance: DEFAULT_APPEARANCE,
  }
  if (!(await persist(placed))) {
    closeTiles(tiles)
    throw new Error('local template could not be saved')
  }
  templates.set(template.id, placed)
  log('install', `placed ${template.name}`, { tiles: tiles.size })
  notify()
  return placed
}

/** Rehydrate on startup, before the first frame if possible. */
export const restoreLocalTemplates = async (): Promise<void> => {
  const stored = await loadTemplates()
  let restored = 0
  for (const template of stored) {
    try {
      // Earlier builds could persist 0x0, non-finite, out-of-world, or fully transparent records.
      // Validate each independently so one bad legacy entry cannot prevent every good restore.
      validatePlacement(template)
      if (template.opaque <= 0) throw new RangeError('template has no painted pixels')
      templates.set(template.id, {
        appearance: DEFAULT_APPEARANCE,
        ...template,
        tiles: await slice(template),
      })
      restored++
    } catch (error) {
      await deleteTemplate(template.id)
      warn('install', `discarded invalid local template ${template.name}`, String(error))
    }
  }
  if (restored > 0) log('install', `restored ${restored} local templates`)
  notify()
}

interface MoveTarget {
  readonly originX: number
  readonly originY: number
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

interface MoveQueue {
  pending: MoveTarget | null
  running: boolean
}

const moveQueues = new Map<string, MoveQueue>()

const drainMoves = async (id: string, queue: MoveQueue): Promise<void> => {
  queue.running = true
  while (queue.pending !== null) {
    const target = queue.pending
    queue.pending = null
    const existing = templates.get(id)
    if (existing === undefined) {
      target.resolve()
      continue
    }
    try {
      const moved = { ...existing, originX: target.originX, originY: target.originY }
      const tiles = await slice(moved)
      // Pointer events can arrive much faster than a tile can be rebuilt. Do not install stale
      // intermediate work; discard it and immediately build only the newest requested position.
      if (queue.pending !== null) {
        closeTiles(tiles)
        target.resolve()
        continue
      }
      const current = templates.get(id)
      if (current === undefined) {
        closeTiles(tiles)
        target.resolve()
        continue
      }
      const next = { ...current, originX: target.originX, originY: target.originY, tiles }
      clearStamped(id)
      templates.set(id, next)
      closeTiles(current.tiles)
      if (!(await persist(next))) warn('install', `move for ${next.name} was not saved`)
      notify()
      target.resolve()
    } catch (error) {
      target.reject(error)
    }
  }
  queue.running = false
  if (queue.pending === null) moveQueues.delete(id)
}

/** Move a template and re-slice it, coalescing pointer updates so only the latest one wins. */
export const moveLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const roundedX = Math.round(originX)
  const roundedY = Math.round(originY)
  validatePlacement(existing, roundedX, roundedY)
  const queue = moveQueues.get(id) ?? { pending: null, running: false }
  moveQueues.set(id, queue)
  await new Promise<void>((resolve, reject) => {
    // A not-yet-started intermediate request is superseded. Its caller does not need to wait for
    // work that deliberately will never be applied.
    queue.pending?.resolve()
    queue.pending = { originX: roundedX, originY: roundedY, resolve, reject }
    if (!queue.running) void drainMoves(id, queue)
  })
}

export const markPlaced = async (id: string): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, everPlaced: true }
  templates.set(id, next)
  if (!(await persist(next))) warn('install', `placement for ${next.name} was not saved`)
}

export const removeLocalTemplate = async (id: string): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  closeTiles(existing.tiles)
  clearStamped(id)
  templates.delete(id)
  if (!(await writeInOrder(id, async () => await deleteTemplate(id))))
    warn('install', `deletion of ${existing.name} was not saved`)
  notify()
}

export const setLocalVisible = async (id: string, visible: boolean): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, visible }
  templates.set(id, next)
  if (!visible) clearStamped(id)
  if (!(await persist(next))) warn('install', `visibility for ${next.name} was not saved`)
  notify()
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
export const setAppearance = async (id: string, appearance: Appearance): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, appearance }
  clearStamped(id)
  templates.set(id, next)
  if (!(await persist(next))) warn('install', `appearance for ${next.name} was not saved`)
  notify()
}

/**
 * A tile stamped for one appearance, cached until that appearance changes.
 *
 * Shape, size, anchor and per-overlay colour filtering all decide *what each pixel looks like*, so
 * they belong in the bitmap rather than in a per-frame loop — a 1000x1000 tile is a million pixels
 * and the frame budget is 16ms. `full` needs no stamping at all and returns the mip chain
 * untouched, which is why it costs nothing.
 */
const stamped = new Map<string, { key: string; tile: TileLevels }>()
const pendingStamps = new Map<string, string>()

const clearStamped = (id: string): void => {
  const prefix = `${id}|`
  for (const key of pendingStamps.keys()) {
    if (key.startsWith(prefix)) pendingStamps.delete(key)
  }
  for (const [key, entry] of stamped) {
    if (!key.startsWith(prefix)) continue
    closeLevels(entry.tile)
    stamped.delete(key)
  }
}

const appearanceKey = (a: Appearance): string =>
  `${a.shape}|${a.size}|${a.anchor}|${a.hiddenColours.join(',')}`

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
  const wanted = `${template.originX},${template.originY}|${appearanceKey(renderedAppearance)}`
  if (renderedAppearance.shape === 'full' && renderedAppearance.hiddenColours.length === 0)
    return source

  const cacheKey = `${template.id}|${tileKey}`
  const hit = stamped.get(cacheKey)
  if (hit !== undefined && hit.key === wanted) return hit.tile
  if (pendingStamps.get(cacheKey) !== wanted) {
    pendingStamps.set(cacheKey, wanted)
    void buildStamp(template, tileKey, renderedAppearance)
      .then((built) => {
        // A move, removal, appearance change, or zoom-threshold crossing supersedes this work.
        if (pendingStamps.get(cacheKey) !== wanted) {
          if (built !== null) closeLevels(built)
          return
        }
        pendingStamps.delete(cacheKey)
        if (built === null) return
        const replaced = stamped.get(cacheKey)
        if (replaced !== undefined) closeLevels(replaced.tile)
        stamped.set(cacheKey, { key: wanted, tile: built })
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
): Promise<TileLevels | null> => {
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
  }
  return { levels: await buildLevels(new ImageData(rgba, size, size)) }
}

/**
 * A template as an indexed PNG, ready to upload.
 *
 * The server quantises on ingest anyway, but sending the already-quantised pixels means what was
 * previewed locally is byte-identical to what is stored — no second opinion from a second
 * quantiser on the way through.
 */
export const templateAsPng = async (template: PlacedTemplate): Promise<Blob | null> => {
  const canvas = new OffscreenCanvas(template.width, template.height)
  const context = canvas.getContext('2d')
  if (context === null) return null
  const rgba = new Uint8ClampedArray(template.width * template.height * 4)
  for (let index = 0; index < template.indices.length; index++) {
    const palette = template.indices[index] ?? TRANSPARENT_INDEX
    if (palette === TRANSPARENT_INDEX) continue
    const colour = WPLACE_PALETTE[palette]
    if (colour === undefined) continue
    rgba[index * 4] = colour.rgb[0]
    rgba[index * 4 + 1] = colour.rgb[1]
    rgba[index * 4 + 2] = colour.rgb[2]
    rgba[index * 4 + 3] = 255
  }
  context.putImageData(new ImageData(rgba, template.width, template.height), 0, 0)
  return await canvas.convertToBlob({ type: 'image/png' })
}
