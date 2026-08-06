import { TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
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

export interface PlacedTemplate extends ImportedTemplate {
  /** Keyed `x/y`; only tiles the template actually covers appear. */
  readonly tiles: ReadonlyMap<string, ImageBitmap>
  readonly visible: boolean
  /**
   * Whether a placement has ever been applied to this template.
   *
   * A freshly imported image has never been anywhere, so cancelling its first placement should
   * remove it rather than leave it stranded at a position nobody chose.
   */
  readonly everPlaced: boolean
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
const slice = async (template: ImportedTemplate): Promise<Map<string, ImageBitmap>> => {
  const firstTileX = Math.floor(template.originX / TILE_SIZE)
  const firstTileY = Math.floor(template.originY / TILE_SIZE)
  const lastTileX = Math.floor((template.originX + template.width - 1) / TILE_SIZE)
  const lastTileY = Math.floor((template.originY + template.height - 1) / TILE_SIZE)

  const out = new Map<string, ImageBitmap>()
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
      out.set(
        `${tileX}/${tileY}`,
        await createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE)),
      )
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
  const placed: PlacedTemplate = { ...template, tiles, visible: true, everPlaced: false }
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
    templates.set(template.id, { ...template, tiles: await slice(template) })
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
  for (const bitmap of existing.tiles.values()) bitmap.close()
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
  for (const bitmap of existing.tiles.values()) bitmap.close()
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
