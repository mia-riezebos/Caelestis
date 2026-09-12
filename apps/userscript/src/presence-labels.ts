import {
  type PresenceRect,
  type RegionDocument,
  type RegionPixelComponents,
  type RegionShapePixels,
  regionPixelComponents,
} from '@caelestis/shared'
import { claimEditorEditingIds } from './claim-editor.js'
import { displayedPresenceRect, regionPixelsFor } from './gl/presence-layer.js'
import { presenceView } from './presence-client.js'
import { presenceCss } from './presence-colour.js'
import { canvasPixelAt, rectOnScreen } from './presence-geometry.js'
import { getState } from './state.js'
import { isDrawingTiles, type TileFrame } from './tile-transform.js'

/**
 * Name tags for what the presence layer draws, shown only for what the pointer is over.
 *
 * Text cannot go through the GL layer, so these are small DOM chips. Each sits centred just above
 * the thing it names: a peer's viewport or drafted pixels, or one self-contained piece of a claim.
 * A claim made of several separate pieces has a tag per piece, so a stroke far from the main
 * shape still says whose it is; when two pieces are so close that their tags would collide, the
 * pieces share one tag above them both, and they get their own again once zoomed in far enough
 * for the tags to fit. Nothing shows until the pointer rests on the shape, so a crowded artwork
 * stays readable.
 */

const HOST_ID = 'caelestis-presence-labels'
/** Space between the tag's bottom edge and the top of what it names, in CSS pixels. */
const GAP = 4
const INSET = 4
const TAG_HEIGHT = 17
/** Roughly the width of the chip for a text, before it exists to be measured. */
const estimateWidth = (text: string): number => Math.round(text.length * 6.6 + 12)

export interface PresenceTag {
  readonly key: string
  readonly text: string
  readonly colour: string
  /** Canvas rect the tag sits above. */
  readonly rect: PresenceRect
}

interface Placed extends PresenceTag {
  /** CSS pixel position of the chip's top-left corner. */
  readonly x: number
  readonly y: number
  readonly width: number
}

let host: HTMLElement | null = null
const nodes = new Map<string, HTMLElement>()
let pointer: { x: number; y: number } | null = null
let pointerWatched = false

/** Rasterised pieces of each claim, per document identity, so hovering costs a lookup. */
const pieces = new Map<
  string,
  { document: RegionDocument; pixels: RegionShapePixels; components: RegionPixelComponents }
>()

const piecesFor = (
  id: string,
  document: RegionDocument,
): { pixels: RegionShapePixels; components: RegionPixelComponents } | null => {
  const held = pieces.get(id)
  if (held?.document === document) return held
  const pixels = regionPixelsFor(id, document)
  if (pixels === null) {
    pieces.delete(id)
    return null
  }
  const entry = { document, pixels, components: regionPixelComponents(pixels) }
  pieces.set(id, entry)
  return entry
}

const contains = (rect: PresenceRect, x: number, y: number): boolean =>
  x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h

const overMap = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (target.classList.contains('maplibregl-canvas') ||
    target.closest('#caelestis-claim-overlay') !== null)

const watchPointer = (window: Window): void => {
  if (pointerWatched) return
  pointerWatched = true
  window.addEventListener(
    'pointermove',
    (event) => {
      pointer = overMap(event.target) ? { x: event.clientX, y: event.clientY } : null
    },
    { capture: true, passive: true },
  )
  const clear = (): void => {
    pointer = null
  }
  window.addEventListener('pointerleave', clear, { capture: true, passive: true })
  window.addEventListener('blur', clear)
  window.document.addEventListener('pointercancel', clear, { capture: true, passive: true })
}

const ensureHost = (document: Document): HTMLElement => {
  if (host?.isConnected) return host
  host = document.getElementById(HOST_ID)
  if (host !== null) return host
  host = document.createElement('div')
  host.id = HOST_ID
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '20',
    font: '600 11px/1.3 ui-sans-serif, system-ui, sans-serif',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(host)
  return host
}

/** The chip's screen box above a canvas rect, in device pixels of the frame. */
const chipAbove = (
  frame: TileFrame,
  rect: PresenceRect,
  width: number,
  ratio: number,
): { x: number; y: number; width: number; height: number } | null => {
  const screen = rectOnScreen(frame, rect)
  if (screen === null) return null
  const w = width * ratio
  const h = (TAG_HEIGHT + GAP) * ratio
  return { x: screen.x + screen.width / 2 - w / 2, y: screen.y - h, width: w, height: h }
}

const boxesTouch = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const union = (rects: readonly PresenceRect[]): PresenceRect => {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x)
    y0 = Math.min(y0, rect.y)
    x1 = Math.max(x1, rect.x + rect.w)
    y1 = Math.max(y1, rect.y + rect.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const screenBox = (
  frame: TileFrame,
  rect: PresenceRect,
): { x: number; y: number; width: number; height: number } | null => rectOnScreen(frame, rect)

/**
 * The pieces of a claim that share a tag with the piece at `index`.
 *
 * A tag must not cover any piece of its own claim, and tags must not cover each other, so two
 * clusters merge when either one's tag would land on a piece of the other or on the other's tag.
 * A cluster's tag sits above the union of its members, which is above the topmost member, so it
 * can cover none of them; that is why the topmost piece wins over the largest. The merged tag may
 * reach yet another piece, so this repeats until nothing more merges. The relation is the same
 * whichever piece is hovered, and zoomed in far enough for the tags to fit in the gaps, every
 * piece is a cluster of one again.
 */
const clusterWith = (
  frame: TileFrame,
  boxes: readonly PresenceRect[],
  index: number,
  width: number,
  ratio: number,
): PresenceRect => {
  const shapes = boxes.map((box) => screenBox(frame, box))
  let clusters = boxes.map((_, member) => [member])
  for (let pass = 0; pass < boxes.length; pass++) {
    const rects = clusters.map((members) => union(members.map((m) => boxes[m] as PresenceRect)))
    const chips = rects.map((rect) => chipAbove(frame, rect, width, ratio))
    const lands = (chip: ReturnType<typeof chipAbove>, members: readonly number[]): boolean =>
      chip !== null &&
      members.some((member) => {
        const shape = shapes[member]
        return shape !== null && shape !== undefined && boxesTouch(chip, shape)
      })
    let merged = false
    const next: number[][] = []
    const taken = new Set<number>()
    for (let a = 0; a < clusters.length; a++) {
      if (taken.has(a)) continue
      const group = [...(clusters[a] as number[])]
      taken.add(a)
      for (let b = a + 1; b < clusters.length; b++) {
        if (taken.has(b)) continue
        const chipA = chips[a] ?? null
        const chipB = chips[b] ?? null
        const touch =
          lands(chipA, clusters[b] as number[]) ||
          lands(chipB, clusters[a] as number[]) ||
          (chipA !== null && chipB !== null && boxesTouch(chipA, chipB))
        if (!touch) continue
        group.push(...(clusters[b] as number[]))
        taken.add(b)
        merged = true
      }
      next.push(group)
    }
    clusters = next
    if (!merged) break
  }
  const mine = clusters.find((members) => members.includes(index)) ?? [index]
  return union(mine.map((member) => boxes[member] as PresenceRect))
}

const regionText = (displayName: string, label: string): string =>
  label === '' ? `${displayName} · claimed` : `${displayName} · ${label}`

/**
 * The tags to show for a pointer at a canvas pixel: one per hovered peer, and one for the hovered
 * piece of each hovered claim (or the cluster of pieces it shares a tag with at this zoom).
 * `measure` gives a tag's width in CSS pixels; `ratio` is device pixels per CSS pixel.
 */
export const presenceTagsAt = (
  frame: TileFrame,
  at: { readonly x: number; readonly y: number },
  measure: (text: string) => number = estimateWidth,
  ratio = 1,
): PresenceTag[] => {
  const view = presenceView()
  const tags: PresenceTag[] = []
  for (const peer of view.peers) {
    const colour = presenceCss(peer.painter.wplaceUserId, 0.85)
    const painting = peer.draft !== null
    const text = painting
      ? `${peer.painter.displayName} · painting ${peer.draft?.pixels ?? 0} px`
      : peer.painter.displayName
    const draftKey = `peer:${peer.sessionId}:draft`
    const viewportKey = `peer:${peer.sessionId}:viewport`
    const draftRect =
      peer.draft === null ? null : (displayedPresenceRect(draftKey) ?? peer.draft.rect)
    const viewportRect =
      peer.viewport === null ? null : (displayedPresenceRect(viewportKey) ?? peer.viewport)
    if (draftRect !== null && contains(draftRect, at.x, at.y))
      tags.push({ key: draftKey, text, colour, rect: draftRect })
    else if (viewportRect !== null && contains(viewportRect, at.x, at.y))
      tags.push({ key: viewportKey, text, colour, rect: viewportRect })
  }
  const editing = new Set(claimEditorEditingIds())
  const seen = new Set<string>()
  for (const region of view.regions) {
    seen.add(region.id)
    if (editing.has(region.id)) continue
    const held = piecesFor(region.id, region.document)
    if (held === null || !contains(held.pixels.rect, at.x, at.y)) continue
    const index = (at.y - held.pixels.rect.y) * held.pixels.rect.w + (at.x - held.pixels.rect.x)
    const label = held.components.labels[index] ?? 0
    if (label === 0) continue
    const text = regionText(region.claimant.displayName, region.label)
    const rect = clusterWith(frame, held.components.boxes, label - 1, measure(text), ratio)
    tags.push({
      key: `region:${region.id}`,
      text,
      colour: presenceCss(region.claimant.wplaceUserId, 0.85),
      rect,
    })
  }
  for (const id of [...pieces.keys()]) if (!seen.has(id)) pieces.delete(id)
  return tags
}

/**
 * Pieces of every claim except `except`, as canvas rects. A tag cannot merge with another
 * painter's claim, so it is nudged up until it clears these instead.
 */
export const otherClaimPieces = (except: string): PresenceRect[] => {
  const view = presenceView()
  const editing = new Set(claimEditorEditingIds())
  const boxes: PresenceRect[] = []
  for (const region of view.regions) {
    if (region.id === except || editing.has(region.id)) continue
    const held = piecesFor(region.id, region.document)
    if (held !== null) boxes.push(...held.components.boxes)
  }
  return boxes
}

const removeAll = (): void => {
  for (const node of nodes.values()) node.remove()
  nodes.clear()
}

const measureWith =
  (document: Document, container: HTMLElement) =>
  (text: string): number => {
    const probe = document.createElement('span')
    Object.assign(probe.style, {
      position: 'absolute',
      visibility: 'hidden',
      padding: '1px 6px',
      whiteSpace: 'nowrap',
    } satisfies Partial<CSSStyleDeclaration>)
    probe.textContent = text
    container.appendChild(probe)
    const width = probe.offsetWidth
    probe.remove()
    return width > 0 ? width : estimateWidth(text)
  }

/** Place the tags for this frame. Cheap when the pointer is off the map. */
export const renderPresenceLabels = (frame: TileFrame): void => {
  const document = frame.canvas.ownerDocument
  const window = document.defaultView
  if (window !== null) watchPointer(window)
  if (
    pointer === null ||
    !getState().showPresence ||
    !isDrawingTiles() ||
    frame.quads.length === 0
  ) {
    removeAll()
    return
  }
  const box = frame.canvas.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) {
    removeAll()
    return
  }
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const at = canvasPixelAt(frame, (pointer.x - box.left) * ratioX, (pointer.y - box.top) * ratioY)
  if (at === null) {
    removeAll()
    return
  }
  const container = ensureHost(document)
  const wanted = presenceTagsAt(frame, at, measureWith(document, container), ratioX)
  if (wanted.length === 0 && nodes.size === 0) return
  const placed: Placed[] = []
  for (const tag of wanted) {
    const screen = rectOnScreen(frame, tag.rect)
    if (screen === null) continue
    let node = nodes.get(tag.key)
    if (node === undefined) {
      node = document.createElement('span')
      Object.assign(node.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        padding: '1px 6px',
        borderRadius: '4px',
        color: '#fff',
        whiteSpace: 'nowrap',
        textShadow: '0 1px 1px rgb(0 0 0 / 0.4)',
        willChange: 'transform',
      } satisfies Partial<CSSStyleDeclaration>)
      container.appendChild(node)
      nodes.set(tag.key, node)
    }
    if (node.textContent !== tag.text) node.textContent = tag.text
    if (node.style.background !== tag.colour) node.style.background = tag.colour
    const width = node.offsetWidth || estimateWidth(tag.text)
    const centre = box.left + (screen.x + screen.width / 2) / ratioX
    const top = box.top + screen.y / ratioY
    let x = Math.round(centre - width / 2)
    x = Math.min(Math.max(x, box.left + INSET), box.right - width - INSET)
    let y = Math.round(top - GAP - TAG_HEIGHT)
    // Another painter's claim cannot share this tag, so the tag climbs until it is clear of it.
    if (tag.key.startsWith('region:')) {
      const obstacles = otherClaimPieces(tag.key.slice('region:'.length))
        .map((piece) => rectOnScreen(frame, piece))
        .filter((piece) => piece !== null)
        .map((piece) => ({
          left: box.left + piece.x / ratioX,
          top: box.top + piece.y / ratioY,
          right: box.left + (piece.x + piece.width) / ratioX,
          bottom: box.top + (piece.y + piece.height) / ratioY,
        }))
      for (let guard = 0; guard < obstacles.length; guard++) {
        const hit = obstacles.find(
          (piece) =>
            x < piece.right &&
            piece.left < x + width &&
            y < piece.bottom &&
            piece.top < y + TAG_HEIGHT,
        )
        if (hit === undefined) break
        y = Math.round(hit.top - GAP - TAG_HEIGHT)
      }
    }
    // Above the map's top edge there is nowhere to go but inside, just under the edge.
    if (y < box.top + INSET) y = Math.round(Math.min(top + INSET, box.bottom - TAG_HEIGHT - INSET))
    // Tags for different things must not cover each other: stack upward on a collision.
    for (let guard = 0; guard < placed.length; guard++) {
      const other = placed.find(
        (held) =>
          x < held.x + held.width &&
          held.x < x + width &&
          y < held.y + TAG_HEIGHT &&
          held.y < y + TAG_HEIGHT,
      )
      if (other === undefined) break
      y = other.y - TAG_HEIGHT - 2
    }
    placed.push({ ...tag, x, y, width })
    node.style.transform = `translate(${x}px, ${y}px)`
  }
  const kept = new Set(placed.map((tag) => tag.key))
  for (const [key, node] of nodes) {
    if (kept.has(key)) continue
    node.remove()
    nodes.delete(key)
  }
}

/** Test seam: forget the pointer, the chips, and the cached pieces. */
export const resetPresenceLabels = (): void => {
  removeAll()
  pieces.clear()
  pointer = null
}
