import { TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
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
const MIP_LEVELS = 4

const buildLevels = async (full: ImageData): Promise<ImageBitmap[]> => {
  const levels: ImageBitmap[] = [await createImageBitmap(full)]
  let width = full.width
  let height = full.height
  let source: CanvasImageSource = levels[0] as ImageBitmap
  for (let level = 1; level < MIP_LEVELS; level++) {
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
}

const slice = async (template: ImportedTemplate): Promise<Map<string, TileLevels>> => {
  const firstTileX = Math.floor(template.originX / TILE_SIZE)
  const firstTileY = Math.floor(template.originY / TILE_SIZE)
  const lastTileX = Math.floor((template.originX + template.width - 1) / TILE_SIZE)
  const lastTileY = Math.floor((template.originY + template.height - 1) / TILE_SIZE)

  const out = new Map<string, TileLevels>()
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
}

const persist = (placed: PlacedTemplate): void => {
  const { tiles: _tiles, ...rest } = placed
  void saveTemplate(rest)
}

export const addLocalTemplate = async (template: ImportedTemplate): Promise<PlacedTemplate> => {
  const tiles = await slice(template)
  const placed: PlacedTemplate = {
    ...template,
    tiles,
    visible: true,
    everPlaced: false,
    appearance: DEFAULT_APPEARANCE,
  }
  templates.set(template.id, placed)
  persist(placed)
  log('install', `placed ${template.name}`, { tiles: tiles.size })
  notify()
  return placed
}

/** Rehydrate on startup, before the first frame if possible. */
export const restoreLocalTemplates = async (): Promise<void> => {
  const stored = await loadTemplates()
  for (const template of stored) {
    // Drop anything zero-sized. An earlier build read ImageBitmap dimensions after closing the
    // bitmap and stored 0x0 templates; they can never render and would sit in the tree forever.
    if (template.width <= 0 || template.height <= 0) {
      void deleteTemplate(template.id)
      continue
    }
    templates.set(template.id, {
      appearance: DEFAULT_APPEARANCE,
      ...template,
      tiles: await slice(template),
    })
  }
  if (stored.length > 0) log('install', `restored ${stored.length} local templates`)
  notify()
}

/** Move a template and re-slice it. Called on drop, not during a drag. */
export const moveLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<void> => {
  const existing = templates.get(id)
  if (existing === undefined) return
  for (const tile of existing.tiles.values()) for (const level of tile.levels) level.close()
  const moved = { ...existing, originX: Math.round(originX), originY: Math.round(originY) }
  const next = { ...moved, tiles: await slice(moved) }
  templates.set(id, next)
  persist(next)
  notify()
}

export const markPlaced = (id: string): void => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, everPlaced: true }
  templates.set(id, next)
  persist(next)
}

export const removeLocalTemplate = (id: string): void => {
  const existing = templates.get(id)
  if (existing === undefined) return
  for (const tile of existing.tiles.values()) for (const level of tile.levels) level.close()
  templates.delete(id)
  void deleteTemplate(id)
  notify()
}

export const setLocalVisible = (id: string, visible: boolean): void => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, visible }
  templates.set(id, next)
  persist(next)
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
export const setAppearance = (id: string, appearance: Appearance): void => {
  const existing = templates.get(id)
  if (existing === undefined) return
  const next = { ...existing, appearance }
  templates.set(id, next)
  persist(next)
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

const appearanceKey = (a: Appearance): string =>
  `${a.shape}|${a.size}|${a.anchor}|${a.hiddenColours.join(',')}`

export const stampTile = (
  template: PlacedTemplate,
  tileKey: string,
  appearance: Appearance,
): TileLevels | undefined => {
  const source = template.tiles.get(tileKey)
  if (source === undefined) return undefined
  // Opacity is applied at draw time, so it is deliberately not part of the cache key — dragging
  // that slider must not rebuild a million pixels per frame.
  const wanted = appearanceKey(appearance)
  if (appearance.shape === 'full' && appearance.hiddenColours.length === 0) return source

  const cacheKey = `${template.id}|${tileKey}`
  const hit = stamped.get(cacheKey)
  if (hit !== undefined && hit.key === wanted) return hit.tile

  const built = buildStamp(template, tileKey, appearance)
  if (built === null) return source
  stamped.set(cacheKey, { key: wanted, tile: built })
  return built
}

const buildStamp = (
  template: PlacedTemplate,
  tileKey: string,
  appearance: Appearance,
): TileLevels | null => {
  const [tx, ty] = tileKey.split('/').map(Number)
  if (tx === undefined || ty === undefined) return null
  const scale = scaleFor(appearance)
  const size = TILE_SIZE * scale
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')
  if (context === null) return null

  const hidden = new Set(appearance.hiddenColours)
  const tileLeft = tx * TILE_SIZE
  const tileTop = ty * TILE_SIZE
  const startX = Math.max(0, tileLeft - template.originX)
  const startY = Math.max(0, tileTop - template.originY)
  const endX = Math.min(template.width, tileLeft + TILE_SIZE - template.originX)
  const endY = Math.min(template.height, tileTop + TILE_SIZE - template.originY)
  const stampSize = appearance.shape === 'full' ? 1 : appearance.size
  const offset = anchorOffset(appearance.anchor, stampSize)

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const index = template.indices[y * template.width + x] ?? TRANSPARENT_INDEX
      if (index === TRANSPARENT_INDEX || hidden.has(index)) continue
      const colour = WPLACE_PALETTE[index]
      if (colour === undefined) continue
      const cellX = (template.originX + x - tileLeft) * scale
      const cellY = (template.originY + y - tileTop) * scale
      const px = cellX + offset.x * scale
      const py = cellY + offset.y * scale
      const side = stampSize * scale
      context.fillStyle = colour.hex
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
    }
  }
  // One level only: a stamped tile is already an intermediate, and rebuilding a mip chain per
  // appearance change would cost more than it saves.
  const bitmap = canvas.transferToImageBitmap()
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
