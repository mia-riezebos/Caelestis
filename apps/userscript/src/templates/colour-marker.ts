import { TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { horizontalSpans } from './placement.js'

interface ColourMarkerTemplate {
  readonly indices: Uint8Array
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly wrapX?: boolean
}

const MAX_ENTRIES_PER_SOURCE = 128
const cache = new WeakMap<Uint8Array, Map<string, Float32Array>>()

/** World-space x,y,wanted triples for one template colour inside one canvas tile. */
export const colourMarksIn = (
  template: ColourMarkerTemplate,
  tile: TileCoord,
  selected: number,
): Float32Array => {
  const key = `${template.originX}/${template.originY}/${template.width}/${template.height}/${template.wrapX === true ? 1 : 0}|${tile.x}/${tile.y}|${selected}`
  const held = cache.get(template.indices)
  const cached = held?.get(key)
  if (cached !== undefined) {
    held?.delete(key)
    held?.set(key, cached)
    return cached
  }

  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const top = Math.max(template.originY, tileTop)
  const bottom = Math.min(template.originY + template.height, tileTop + TILE_SIZE)
  const points: number[] = []

  if (top < bottom) {
    for (const span of horizontalSpans(template)) {
      const left = Math.max(span.worldStart, tileLeft)
      const right = Math.min(span.worldEnd, tileLeft + TILE_SIZE)
      if (left >= right) continue
      const sourceLeft = span.sourceStart + left - span.worldStart
      for (let y = top; y < bottom; y++) {
        let source = (y - template.originY) * template.width + sourceLeft
        for (let x = left; x < right; x++, source++) {
          if (template.indices[source] === selected) points.push(x, y, selected)
        }
      }
    }
  }

  const marks = new Float32Array(points)
  const entries = held ?? new Map<string, Float32Array>()
  entries.set(key, marks)
  while (entries.size > MAX_ENTRIES_PER_SOURCE) {
    const oldest = entries.keys().next()
    if (oldest.done) break
    entries.delete(oldest.value)
  }
  if (held === undefined) cache.set(template.indices, entries)
  return marks
}
