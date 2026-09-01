import { TRANSPARENT_INDEX } from '@caelestis/shared'
import type { Appearance } from '../templates/appearance.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { packMismatchMark } from '../templates/mismatch-marks.js'
import type { ArtboardPixelRegion } from './artboard-pixels.js'

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
  readonly selected: readonly ArtboardMarkerBatch[]
}

interface MutableBatch {
  readonly x: number
  readonly y: number
  readonly marks: number[]
}

interface ArtboardActualPixels {
  readonly pixels: Uint8Array
  readonly known: Uint8Array
}

const artboardActualPixels = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'>,
  regions: readonly ArtboardPixelRegion[],
): ArtboardActualPixels => {
  const pixels = new Uint8Array(template.width * template.height).fill(TRANSPARENT_INDEX)
  const known = new Uint8Array(template.width * template.height)
  for (const region of regions) {
    const left = Math.max(template.originX, region.x)
    const top = Math.max(template.originY, region.y)
    const right = Math.min(template.originX + template.width, region.x + region.width)
    const bottom = Math.min(template.originY + template.height, region.y + region.height)
    for (let y = top; y < bottom; y++) {
      const sourceAt = (y - region.y) * region.width + (left - region.x)
      const targetAt = (y - template.originY) * template.width + (left - template.originX)
      pixels.set(region.pixels.subarray(sourceAt, sourceAt + right - left), targetAt)
      known.fill(1, targetAt, targetAt + right - left)
    }
  }
  return { pixels, known }
}

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
  regions: readonly ArtboardPixelRegion[],
  index: number,
): readonly ArtboardColourTarget[] => {
  const actual = artboardActualPixels(template, regions)
  const targets: ArtboardColourTarget[] = []
  for (let at = 0; at < template.indices.length; at++) {
    if (template.indices[at] !== index || actual.known[at] !== 1 || actual.pixels[at] === index)
      continue
    targets.push({
      x: template.originX + (at % template.width),
      y: template.originY + Math.floor(at / template.width),
      kind: actual.pixels[at] === TRANSPARENT_INDEX ? 'unpainted' : 'mismatched',
    })
  }
  return targets
}

/** Per-colour progress from the native artboard pixels Wplace has loaded. */
export const artboardColourProgress = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  regions: readonly ArtboardPixelRegion[],
): readonly ArtboardColourProgress[] => {
  const actual = artboardActualPixels(template, regions)
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
    const placed = actual.pixels[at]
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

/** Palette colours with at least one artboard pixel that still differs from the template. */
export const artboardRemainingColours = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  regions: readonly ArtboardPixelRegion[],
): ReadonlySet<number> => {
  const actual = artboardActualPixels(template, regions)
  const remaining = new Set<number>()
  for (let at = 0; at < template.indices.length; at++) {
    const wanted = template.indices[at]
    if (
      wanted === undefined ||
      wanted === TRANSPARENT_INDEX ||
      actual.known[at] !== 1 ||
      wanted === actual.pixels[at]
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
    batch = { x: chunkX * MARKER_CHUNK_SIZE, y: chunkY * MARKER_CHUNK_SIZE, marks: [] }
    batches.set(key, batch)
  }
  batch.marks.push(packMismatchMark(x - batch.x, y - batch.y, wanted))
}

const freezeBatches = (batches: Map<string, MutableBatch>): ArtboardMarkerBatch[] =>
  [...batches.values()].map((batch) => ({
    x: batch.x,
    y: batch.y,
    width: MARKER_CHUNK_SIZE,
    height: MARKER_CHUNK_SIZE,
    marks: new Uint32Array(batch.marks),
  }))

/** Compare one alliance template with Wplace's native art, using the world marker semantics. */
export const artboardMarkerWork = (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  regions: readonly ArtboardPixelRegion[],
  appearance: Appearance,
  selectedColour: number | null,
): ArtboardMarkerWork => {
  const actual = artboardActualPixels(template, regions)

  const hidden = new Set(appearance.hiddenColours)
  const wrong: Array<{ x: number; y: number; wanted: number }> = []
  const unpainted: Array<{ x: number; y: number; wanted: number }> = []
  let asserted = 0
  for (let localY = 0; localY < template.height; localY++) {
    for (let localX = 0; localX < template.width; localX++) {
      const at = localY * template.width + localX
      const wanted = template.indices[at]
      if (wanted === undefined || wanted === TRANSPARENT_INDEX || hidden.has(wanted)) continue
      if (actual.known[at] !== 1) continue
      asserted++
      const placed = actual.pixels[at]
      if (placed === wanted) continue
      const mark = { x: template.originX + localX, y: template.originY + localY, wanted }
      if (placed === TRANSPARENT_INDEX) unpainted.push(mark)
      else wrong.push(mark)
    }
  }

  const mismatchBatches = new Map<string, MutableBatch>()
  if (appearance.markMismatch) {
    const includeUnpainted =
      appearance.markUnpainted &&
      asserted > 0 &&
      unpainted.length / asserted <= appearance.unpaintedLimit
    for (const mark of includeUnpainted ? [...wrong, ...unpainted] : wrong)
      appendMark(mismatchBatches, mark.x, mark.y, mark.wanted)
  }

  const selectedBatches = new Map<string, MutableBatch>()
  if (appearance.markSelectedColour && selectedColour !== null && !hidden.has(selectedColour)) {
    for (const mark of unpainted) {
      if (mark.wanted === selectedColour) appendMark(selectedBatches, mark.x, mark.y, mark.wanted)
    }
  }
  return { mismatch: freezeBatches(mismatchBatches), selected: freezeBatches(selectedBatches) }
}
