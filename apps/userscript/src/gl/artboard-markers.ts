import { TRANSPARENT_INDEX } from '@caelestis/shared'
import {
  type NativePixelRect,
  type NativePixelSnapshot,
  nativePixelWindow,
} from '../native-pixels.js'
import type { Appearance } from '../templates/appearance.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { packMismatchMark } from '../templates/mismatch-marks.js'

const MARKER_CHUNK_SIZE = 1_024

export interface ArtboardMarkerBatch {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly marks: Uint32Array
}

export interface ArtboardMarkerWork {
  readonly mismatch: readonly ArtboardMarkerBatch[]
  readonly selected: readonly {
    readonly index: number
    readonly batches: readonly ArtboardMarkerBatch[]
  }[]
}

interface MutableBatch {
  readonly x: number
  readonly y: number
  readonly marks: Set<number>
}

const artboardActualPixels = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'>,
  pixels: NativePixelSnapshot,
) =>
  nativePixelWindow(pixels, {
    x: template.originX,
    y: template.originY,
    width: template.width,
    height: template.height,
  })

export interface ArtboardColourProgress {
  readonly index: number
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  readonly total: number
}

export interface ArtboardColourTarget {
  readonly x: number
  readonly y: number
  readonly kind: 'mismatched' | 'unpainted'
}

/** Known native artboard pixels that still need one palette colour. */
export const artboardColourTargets = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  pixels: NativePixelSnapshot,
  index: number,
): readonly ArtboardColourTarget[] => {
  const actual = artboardActualPixels(template, pixels)
  const targets: ArtboardColourTarget[] = []
  for (let at = 0; at < template.indices.length; at++) {
    if (template.indices[at] !== index || actual.known[at] !== 1 || actual.indices[at] === index)
      continue
    targets.push({
      x: template.originX + (at % template.width),
      y: template.originY + Math.floor(at / template.width),
      kind: actual.indices[at] === TRANSPARENT_INDEX ? 'unpainted' : 'mismatched',
    })
  }
  return targets
}

/** Per-colour progress from the native artboard pixels Wplace has loaded. */
export const artboardColourProgress = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  pixels: NativePixelSnapshot,
): readonly ArtboardColourProgress[] => {
  const actual = artboardActualPixels(template, pixels)
  const progress = new Map<number, ArtboardColourProgress>()
  for (let at = 0; at < template.indices.length; at++) {
    const wanted = template.indices[at]
    if (wanted === undefined || wanted === TRANSPARENT_INDEX) continue
    const previous = progress.get(wanted) ?? {
      index: wanted,
      completed: 0,
      mismatched: 0,
      unpainted: 0,
      known: 0,
      total: 0,
    }
    const known = actual.known[at] === 1
    const placed = actual.indices[at]
    progress.set(wanted, {
      ...previous,
      total: previous.total + 1,
      known: previous.known + (known ? 1 : 0),
      completed: previous.completed + (known && placed === wanted ? 1 : 0),
      mismatched:
        previous.mismatched + (known && placed !== wanted && placed !== TRANSPARENT_INDEX ? 1 : 0),
      unpainted: previous.unpainted + (known && placed === TRANSPARENT_INDEX ? 1 : 0),
    })
  }
  return [...progress.values()].sort((left, right) => left.index - right.index)
}

/** Overall progress for one artboard template, derived from the same per-colour counts. */
export const artboardTemplateProgress = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  pixels: NativePixelSnapshot,
) => {
  const colours = artboardColourProgress(template, pixels)
  return colours.reduce(
    (total, colour) => ({
      completed: total.completed + colour.completed,
      mismatched: total.mismatched + colour.mismatched,
      unpainted: total.unpainted + colour.unpainted,
      known: total.known + colour.known,
      total: total.total + colour.total,
    }),
    { completed: 0, mismatched: 0, unpainted: 0, known: 0, total: 0 },
  )
}

/** Palette colours with at least one artboard pixel that still differs from the template. */
export const artboardRemainingColours = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  pixels: NativePixelSnapshot,
): ReadonlySet<number> => {
  const actual = artboardActualPixels(template, pixels)
  const remaining = new Set<number>()
  for (let at = 0; at < template.indices.length; at++) {
    const wanted = template.indices[at]
    if (
      wanted === undefined ||
      wanted === TRANSPARENT_INDEX ||
      actual.known[at] !== 1 ||
      wanted === actual.indices[at]
    )
      continue
    remaining.add(wanted)
  }
  return remaining
}

const appendMark = (
  batches: Map<string, MutableBatch>,
  x: number,
  y: number,
  wanted: number,
): void => {
  const chunkX = Math.floor(x / MARKER_CHUNK_SIZE)
  const chunkY = Math.floor(y / MARKER_CHUNK_SIZE)
  const key = `${chunkX}/${chunkY}`
  let batch = batches.get(key)
  if (batch === undefined) {
    batch = { x: chunkX * MARKER_CHUNK_SIZE, y: chunkY * MARKER_CHUNK_SIZE, marks: new Set() }
    batches.set(key, batch)
  }
  batch.marks.add(packMismatchMark(x - batch.x, y - batch.y, wanted))
}

const deleteMark = (
  batches: Map<string, MutableBatch>,
  x: number,
  y: number,
  wanted: number,
): void => {
  const key = `${Math.floor(x / MARKER_CHUNK_SIZE)}/${Math.floor(y / MARKER_CHUNK_SIZE)}`
  const batch = batches.get(key)
  if (batch === undefined) return
  batch.marks.delete(packMismatchMark(x - batch.x, y - batch.y, wanted))
  if (batch.marks.size === 0) batches.delete(key)
}

const freezeBatches = (batches: Map<string, MutableBatch>): ArtboardMarkerBatch[] =>
  [...batches.values()].map((batch) => ({
    x: batch.x,
    y: batch.y,
    width: MARKER_CHUNK_SIZE,
    height: MARKER_CHUNK_SIZE,
    marks: new Uint32Array(
      [...batch.marks].sort((left, right) => (left & 0xfffff) - (right & 0xfffff)),
    ),
  }))

type MarkerClassification = 0 | 1 | 2

interface MarkerIndexEntry {
  readonly source: Uint8Array
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly hiddenKey: string
  readonly hidden: ReadonlySet<number>
  readonly known: Uint8Array
  readonly classification: Uint8Array
  readonly wrong: Map<string, MutableBatch>
  readonly unpainted: Map<string, MutableBatch>
  readonly selected: Map<number, Map<string, MutableBatch>>
  asserted: number
  unpaintedCount: number
  cachedIncludeUnpainted: boolean | null
  cached: ArtboardMarkerWork | null
}

const hiddenKeyFor = (appearance: Appearance): string =>
  [...appearance.hiddenColours].sort((left, right) => left - right).join(',')

const overlaps = (left: NativePixelRect, right: NativePixelRect): NativePixelRect | null => {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const farX = Math.min(left.x + left.width, right.x + right.width)
  const farY = Math.min(left.y + left.height, right.y + right.height)
  return farX <= x || farY <= y ? null : { x, y, width: farX - x, height: farY - y }
}

const selectedBatches = (entry: MarkerIndexEntry, wanted: number) => {
  let batches = entry.selected.get(wanted)
  if (batches === undefined) {
    batches = new Map()
    entry.selected.set(wanted, batches)
  }
  return batches
}

const removeClassification = (
  entry: MarkerIndexEntry,
  classification: MarkerClassification,
  x: number,
  y: number,
  wanted: number,
): void => {
  if (classification === 1) deleteMark(entry.wrong, x, y, wanted)
  if (classification !== 2) return
  deleteMark(entry.unpainted, x, y, wanted)
  const selected = entry.selected.get(wanted)
  if (selected === undefined) return
  deleteMark(selected, x, y, wanted)
  if (selected.size === 0) entry.selected.delete(wanted)
}

const addClassification = (
  entry: MarkerIndexEntry,
  classification: MarkerClassification,
  x: number,
  y: number,
  wanted: number,
): void => {
  if (classification === 1) appendMark(entry.wrong, x, y, wanted)
  if (classification !== 2) return
  appendMark(entry.unpainted, x, y, wanted)
  appendMark(selectedBatches(entry, wanted), x, y, wanted)
}

/** Retain alliance marker classifications and patch only native pixels Wplace changed. */
export class ArtboardMarkerIndex {
  private entry: MarkerIndexEntry | null = null
  private compared = 0

  private create(
    template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
    appearance: Appearance,
  ): MarkerIndexEntry {
    const hiddenKey = hiddenKeyFor(appearance)
    return {
      source: template.indices,
      originX: template.originX,
      originY: template.originY,
      width: template.width,
      height: template.height,
      hiddenKey,
      hidden: new Set(appearance.hiddenColours),
      known: new Uint8Array(template.indices.length),
      classification: new Uint8Array(template.indices.length),
      wrong: new Map(),
      unpainted: new Map(),
      selected: new Map(),
      asserted: 0,
      unpaintedCount: 0,
      cachedIncludeUnpainted: null,
      cached: null,
    }
  }

  private matches(
    entry: MarkerIndexEntry,
    template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
    appearance: Appearance,
  ): boolean {
    return (
      entry.source === template.indices &&
      entry.originX === template.originX &&
      entry.originY === template.originY &&
      entry.width === template.width &&
      entry.height === template.height &&
      entry.hiddenKey === hiddenKeyFor(appearance)
    )
  }

  isCurrent(
    template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
    appearance: Appearance,
  ): boolean {
    return this.entry !== null && this.matches(this.entry, template, appearance)
  }

  private patch(
    entry: MarkerIndexEntry,
    template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
    pixels: NativePixelSnapshot,
    dirty: NativePixelRect,
  ): void {
    const templateRect = {
      x: template.originX,
      y: template.originY,
      width: template.width,
      height: template.height,
    }
    const overlap = overlaps(dirty, templateRect)
    if (overlap === null) return
    const actual = nativePixelWindow(pixels, overlap)
    this.compared += overlap.width * overlap.height
    for (let y = 0; y < overlap.height; y++) {
      for (let x = 0; x < overlap.width; x++) {
        const localX = overlap.x - template.originX + x
        const localY = overlap.y - template.originY + y
        const at = localY * template.width + localX
        const actualAt = y * overlap.width + x
        const wanted = template.indices[at]
        if (wanted === undefined) continue
        const asserted = wanted !== TRANSPARENT_INDEX && !entry.hidden.has(wanted)
        const nextKnown = asserted && actual.known[actualAt] === 1 ? 1 : 0
        const placed = actual.indices[actualAt]
        const nextClassification: MarkerClassification =
          nextKnown === 0 || placed === wanted ? 0 : placed === TRANSPARENT_INDEX ? 2 : 1
        const previousKnown = entry.known[at] ?? 0
        const previousClassification = (entry.classification[at] ?? 0) as MarkerClassification
        if (previousKnown === nextKnown && previousClassification === nextClassification) continue
        const worldX = template.originX + localX
        const worldY = template.originY + localY
        if (previousKnown === 1) entry.asserted--
        if (previousClassification === 2) entry.unpaintedCount--
        removeClassification(entry, previousClassification, worldX, worldY, wanted)
        entry.known[at] = nextKnown
        entry.classification[at] = nextClassification
        if (nextKnown === 1) entry.asserted++
        if (nextClassification === 2) entry.unpaintedCount++
        addClassification(entry, nextClassification, worldX, worldY, wanted)
        entry.cached = null
      }
    }
  }

  update(
    template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
    pixels: NativePixelSnapshot,
    appearance: Appearance,
    dirty: readonly NativePixelRect[] | null,
  ): ArtboardMarkerWork {
    this.compared = 0
    if (this.entry === null || !this.matches(this.entry, template, appearance)) {
      this.entry = this.create(template, appearance)
      this.patch(this.entry, template, pixels, {
        x: template.originX,
        y: template.originY,
        width: template.width,
        height: template.height,
      })
    } else if (dirty === null) {
      this.patch(this.entry, template, pixels, {
        x: template.originX,
        y: template.originY,
        width: template.width,
        height: template.height,
      })
    } else {
      for (const rect of dirty) this.patch(this.entry, template, pixels, rect)
    }

    const entry = this.entry
    const includeUnpainted =
      appearance.markUnpainted &&
      entry.asserted > 0 &&
      entry.unpaintedCount / entry.asserted <= appearance.unpaintedLimit
    if (entry.cached !== null && entry.cachedIncludeUnpainted === includeUnpainted)
      return entry.cached
    const mismatch = new Map(entry.wrong)
    if (includeUnpainted) {
      for (const [key, unpainted] of entry.unpainted) {
        const held = mismatch.get(key)
        if (held === undefined) {
          mismatch.set(key, unpainted)
          continue
        }
        mismatch.set(key, {
          x: held.x,
          y: held.y,
          marks: new Set([...held.marks, ...unpainted.marks]),
        })
      }
    }
    entry.cached = {
      mismatch: freezeBatches(mismatch),
      selected: [...entry.selected]
        .sort(([left], [right]) => left - right)
        .map(([index, batches]) => ({ index, batches: freezeBatches(batches) })),
    }
    entry.cachedIncludeUnpainted = includeUnpainted
    return entry.cached
  }

  comparedPixels(): number {
    return this.compared
  }
}

/** Compare one alliance template with Wplace's native art, using the world marker semantics. */
export const artboardMarkerWork = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  pixels: NativePixelSnapshot,
  appearance: Appearance,
): ArtboardMarkerWork => {
  return new ArtboardMarkerIndex().update(template, pixels, appearance, null)
}
