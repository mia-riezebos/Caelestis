import { latLngToCanvasPixel, PALETTE_SIZE } from '@caelestis/shared'
import type { CaelestisPaletteProgress } from '@caelestis/ui/elements'
import { count, warn } from './debug.js'
import { getMap } from './map-handle.js'
import { type ConnectedServer, getState, onStateChange } from './state.js'
import { onServerStatusChange, serverColourProgressFor } from './telemetry.js'
import { onLocalChange, type PlacedTemplate } from './templates/local-store.js'
import {
  type ColourNavigationTarget,
  type ColourTargetKind,
  pixelAccounting,
  type TemplateColourProgress,
  type TemplateColourProgressDelta,
  type TemplateDraftPixelDelta,
} from './templates/mismatch.js'
import { navigateTo } from './templates/navigate.js'
import { focusedTemplate } from './templates/nearest.js'
import { onAcceptedPaint } from './tile-transform.js'
import { applyColourProgressDelta } from './ui/progress.js'
import {
  isPaintOpen,
  onPaintSelectionChange,
  selectedColour,
  selectPaintColour,
} from './wplace-paint.js'

/**
 * Per-colour progress for one template where Wplace's own paint controls are used.
 *
 * Local overlays have no server and therefore use their retained client scan. Server overlays keep
 * the server as their complete baseline and project only the exact category transfers made by this
 * browser's native draft. This does not depend on an offscreen tile having been scanned locally.
 */
const connectedServers = (): ReadonlyMap<string, ConnectedServer> =>
  new Map(getState().servers.map((server) => [server.url, server]))

interface DraftProjection {
  readonly baselines: Map<number, TemplateColourProgress>
  readonly pending: Map<string, TemplateDraftPixelDelta>
  readonly acceptedActive: Map<string, TemplateDraftPixelDelta>
}

const draftProjections = new Map<string, DraftProjection>()

const serverCovers = (
  server: TemplateColourProgress,
  target: TemplateColourProgress,
  baseline: TemplateColourProgress,
): boolean => {
  const movement = target.completed - baseline.completed
  return movement > 0
    ? server.completed >= target.completed
    : movement < 0
      ? server.completed <= target.completed
      : true
}

const zeroDelta = (index: number): TemplateColourProgressDelta => ({
  index,
  completed: 0,
  mismatched: 0,
  unpainted: 0,
})

const addDelta = (
  left: TemplateColourProgressDelta,
  right: TemplateColourProgressDelta,
): TemplateColourProgressDelta => ({
  index: left.index,
  completed: left.completed + right.completed,
  mismatched: left.mismatched + right.mismatched,
  unpainted: left.unpainted + right.unpainted,
})

const deltaIsEmpty = (delta: TemplateColourProgressDelta): boolean =>
  delta.completed === 0 && delta.mismatched === 0 && delta.unpainted === 0

const samePixelDelta = (left: TemplateDraftPixelDelta, right: TemplateDraftPixelDelta): boolean =>
  left.key === right.key &&
  left.index === right.index &&
  left.completed === right.completed &&
  left.mismatched === right.mismatched &&
  left.unpainted === right.unpainted

const aggregateColour = (
  index: number,
  pixels: Iterable<TemplateDraftPixelDelta>,
): TemplateColourProgressDelta => {
  let total = zeroDelta(index)
  for (const pixel of pixels) if (pixel.index === index) total = addDelta(total, pixel)
  return total
}

/**
 * Reconcile a draft against the server snapshot that was visible when that colour was first edited.
 * `max(server, projected baseline)` semantics for ordinary corrective painting preserve newer work
 * by other painters and make a status response that includes our paint win without double counting.
 */
const progressWithDrafts = (
  templateId: string,
  server: readonly TemplateColourProgress[],
  pixels: readonly TemplateDraftPixelDelta[],
): readonly TemplateColourProgress[] => {
  let state = draftProjections.get(templateId)
  if (state === undefined) {
    if (pixels.length === 0) return server
    state = { baselines: new Map(), pending: new Map(), acceptedActive: new Map() }
    draftProjections.set(templateId, state)
  }
  const active = new Map(pixels.map((pixel) => [pixel.key, pixel]))
  for (const key of [...state.acceptedActive.keys()]) {
    if (!active.has(key)) state.acceptedActive.delete(key)
  }
  const serverByIndex = new Map(server.map((entry) => [entry.index, entry]))
  for (const pixel of [...state.pending.values(), ...active.values()]) {
    const entry = serverByIndex.get(pixel.index)
    const baseline = state.baselines.get(pixel.index)
    if (entry !== undefined && (baseline === undefined || baseline.total !== entry.total))
      state.baselines.set(pixel.index, entry)
  }

  for (const [index, baseline] of [...state.baselines]) {
    const entry = serverByIndex.get(index)
    if (entry === undefined) {
      state.baselines.delete(index)
      for (const [key, pixel] of state.pending) if (pixel.index === index) state.pending.delete(key)
      continue
    }
    const pending = aggregateColour(index, state.pending.values())
    if (deltaIsEmpty(pending)) continue
    if (serverCovers(entry, applyColourProgressDelta(baseline, pending), baseline)) {
      for (const [key, pixel] of state.pending) if (pixel.index === index) state.pending.delete(key)
      state.baselines.set(index, entry)
    }
  }

  // A current native draft replaces pending work at the same pixel. Once the server has covered an
  // accepted pixel, the still-mounted copy of that same draft is suppressed until Wplace clears it.
  const effective = new Map(state.pending)
  for (const [key, pixel] of active) {
    const accepted = state.acceptedActive.get(key)
    if (!state.pending.has(key) && accepted !== undefined && samePixelDelta(pixel, accepted))
      continue
    effective.set(key, pixel)
  }

  const result = server.map((entry) => {
    const delta = aggregateColour(entry.index, effective.values())
    if (deltaIsEmpty(delta)) return entry
    const baseline = state.baselines.get(entry.index) ?? entry
    const target = applyColourProgressDelta(baseline, delta)
    return serverCovers(entry, target, baseline) ? entry : target
  })
  if (active.size === 0 && state.pending.size === 0) draftProjections.delete(templateId)
  return result
}

const progressForTemplate = (
  template: PlacedTemplate | null,
  servers: ReadonlyMap<string, ConnectedServer> = connectedServers(),
): readonly TemplateColourProgress[] => {
  if (template === null) return []
  const accounting = pixelAccounting.read(template)
  if (template.serverUrl === undefined || template.serverTemplateId === undefined)
    return accounting.colours
  const server = servers.get(template.serverUrl)
  if (server === undefined) return []
  // The drawn template already proves the manifest identity and exact pixel total. Depending on the
  // panel's admitted manifest here made palette counters disappear whenever Paint opened before the
  // main menu had rendered its tree.
  const progress = serverColourProgressFor(server, {
    id: template.serverTemplateId,
    totalPixels: template.opaque,
  })
  return progress === null
    ? []
    : progressWithDrafts(template.id, progress, accounting.draftPixelDeltas)
}

/** Keep an accepted draft visible while its authoritative status response is still in flight. */
const retainAcceptedDraft = (): void => {
  const template = focusedTemplate()
  if (template === null || template.serverUrl === undefined) return
  // Populate the projection from the latest synchronous draft before Wplace clears its canvas.
  progressForTemplate(template)
  const state = draftProjections.get(template.id)
  if (state === undefined) return
  for (const pixel of pixelAccounting.read(template).draftPixelDeltas) {
    if (deltaIsEmpty(pixel)) state.pending.delete(pixel.key)
    else state.pending.set(pixel.key, pixel)
    state.acceptedActive.set(pixel.key, pixel)
  }
}

/** The colour counts decorating Wplace's palette belong only to what the viewport is focused on. */
export const paintPaletteProgress = (): readonly TemplateColourProgress[] =>
  progressForTemplate(focusedTemplate())

const paletteIndexOf = (element: Element): number | null => {
  const raw = Number(element.id.slice('color-'.length))
  const index = raw - 1
  return Number.isInteger(raw) && raw > 0 && index < PALETTE_SIZE ? index : null
}

const originalLabels = new WeakMap<HTMLElement, string>()
const wired = new WeakSet<HTMLElement>()
const PALETTE_SWATCH = '[id^="color-"]'

const renderedPaletteOrder = (): readonly number[] => {
  const seen = new Set<number>()
  const order: number[] = []
  for (const element of document.querySelectorAll<HTMLElement>(PALETTE_SWATCH)) {
    const index = paletteIndexOf(element)
    if (index === null || seen.has(index)) continue
    seen.add(index)
    order.push(index)
  }
  return order
}

let lastNavigation: { readonly index: number; readonly target: ColourNavigationTarget } | null =
  null

/** Navigate within the one shared focused template, optionally cycling past the previous target. */
export const navigateFocusedColour = async (index: number, cycle = false): Promise<boolean> => {
  const template = focusedTemplate()
  if (template === null) return false
  const map = getMap()
  if (map === null) return false
  const reference = latLngToCanvasPixel(map.getCenter())
  const accounting = pixelAccounting.read(template)
  const order: readonly ColourTargetKind[] =
    getState().colourNavigationOrder === 'mismatched-first'
      ? ['mismatched', 'unpainted']
      : ['unpainted', 'mismatched']
  for (const kind of order) {
    const previous =
      cycle &&
      lastNavigation?.index === index &&
      lastNavigation.target.templateId === template.id &&
      lastNavigation.target.kind === kind
        ? lastNavigation.target
        : undefined
    let target = await accounting.nearest(index, kind, reference, previous)
    // Preserve the configured kind priority. If the excluded pixel is the only target of this kind,
    // wrap to it instead of silently dropping into the lower-priority kind.
    if (target === null && previous !== undefined)
      target = await accounting.nearest(index, kind, reference)
    if (target === null) continue
    lastNavigation = { index, target }
    navigateTo({ x: target.x + 0.5, y: target.y + 0.5, width: 1, height: 1 })
    return true
  }
  warn('install', `no remaining pixel for palette colour ${index} in template ${template.id}`)
  return false
}

/** The keyboard form of middle-click: use Wplace's current colour and cycle on repeated presses. */
export const navigateFocusedSelectedColour = async (): Promise<boolean> => {
  const index = selectedColour()
  return index === null ? false : await navigateFocusedColour(index, true)
}

/** Select the previous or next unfinished colour in the focused template, wrapping at either end. */
export const cycleFocusedColour = (direction: -1 | 1): boolean => {
  if (!isPaintOpen()) return false
  const remaining = new Set(
    paintPaletteProgress()
      .filter((entry) => entry.completed < entry.total)
      .map((entry) => entry.index),
  )
  const order = renderedPaletteOrder()
  if (remaining.size === 0 || order.length === 0) return false

  const selected = selectedColour()
  const selectedAt = selected === null ? -1 : order.indexOf(selected)
  let at = selectedAt >= 0 ? selectedAt : direction > 0 ? order.length - 1 : 0
  for (let visited = 0; visited < order.length; visited++) {
    at = (at + direction + order.length) % order.length
    const next = order[at]
    if (next !== undefined && remaining.has(next)) return selectPaintColour(next)
  }
  return false
}

const wire = (swatch: HTMLElement, index: number): void => {
  if (wired.has(swatch)) return
  wired.add(swatch)
  swatch.addEventListener('pointerdown', (event) => {
    if (event.button === 1) event.preventDefault()
  })
  swatch.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    void navigateFocusedColour(index)
  })
}

const render = (): void => {
  const swatches = document.querySelectorAll<HTMLElement>(PALETTE_SWATCH)
  count('paint:palette renders')
  count('paint:palette swatches', swatches.length)
  // Mismatch and telemetry updates also arrive while Wplace's paint drawer is closed. Do not walk
  // every visible template and aggregate its colour totals for a UI that has no mounted consumer.
  if (swatches.length === 0) return
  const progress = new Map(paintPaletteProgress().map((entry) => [entry.index, entry]))
  const navigationLabel =
    getState().colourNavigationOrder === 'mismatched-first'
      ? 'mismatched, then unpainted'
      : 'unpainted, then mismatched'
  count('paint:palette progress colours', progress.size)
  for (const element of swatches) {
    const index = paletteIndexOf(element)
    if (index === null) continue
    wire(element, index)
    const entry = progress.get(index)
    const existing = element.querySelector<CaelestisPaletteProgress>(
      ':scope > caelestis-palette-progress',
    )
    if (entry !== undefined && entry.known < entry.total) {
      const label =
        originalLabels.get(element) ?? element.getAttribute('aria-label') ?? `Colour ${index + 1}`
      originalLabels.set(element, label)
      element.setAttribute('aria-label', `${label}. Checking progress for the focused template.`)
      const badge = existing ?? document.createElement('caelestis-palette-progress')
      badge.className = 'caelestis-palette-progress'
      if (badge.model?.value !== '…') badge.model = { value: '…' }
      if (existing === null) element.appendChild(badge)
      continue
    }
    const remaining = entry === undefined ? 0 : Math.max(0, entry.total - entry.completed)
    if (remaining === 0) {
      existing?.remove()
      const original = originalLabels.get(element)
      if (original !== undefined) element.setAttribute('aria-label', original)
      continue
    }
    const label =
      originalLabels.get(element) ?? element.getAttribute('aria-label') ?? `Colour ${index + 1}`
    originalLabels.set(element, label)
    element.setAttribute(
      'aria-label',
      `${label}. ${remaining.toLocaleString()} ${remaining === 1 ? 'pixel' : 'pixels'} left in the focused template. Middle-click, or select it and press F, to go to its nearest ${navigationLabel} pixel.`,
    )
    const badge = existing ?? document.createElement('caelestis-palette-progress')
    badge.className = 'caelestis-palette-progress'
    const text = remaining.toLocaleString()
    if (badge.model?.value !== text) badge.model = { value: text }
    if (existing === null) element.appendChild(badge)
  }
}

let queued = false
let paletteMounted = false
let focusedTemplateId: string | null = null

const queueRender = (): void => {
  if (!paletteMounted || queued) return
  queued = true
  // A hidden debug tab suspends animation frames entirely, but Wplace can still mount the drawer
  // through automation or restored state. A zero-delay task keeps mutations batched without making
  // palette decoration depend on the map actively painting frames.
  setTimeout(() => {
    queued = false
    render()
  }, 0)
}

const containsPaletteSwatch = (node: Node): boolean =>
  node instanceof Element &&
  (node.matches(PALETTE_SWATCH) || node.querySelector(PALETTE_SWATCH) !== null)

const touchesPalette = (records: readonly MutationRecord[]): boolean => {
  for (const record of records) {
    if (record.target instanceof Element && record.target.closest(PALETTE_SWATCH) !== null)
      return true
    for (const node of record.addedNodes) if (containsPaletteSwatch(node)) return true
    for (const node of record.removedNodes) if (containsPaletteSwatch(node)) return true
  }
  return false
}

const discoverPalette = (): void => {
  paletteMounted = document.querySelector(PALETTE_SWATCH) !== null
  queueRender()
}

/** Refresh the counters only when panning or zooming changes which template owns them. */
export const refreshPaintPaletteFocus = (): void => {
  if (!paletteMounted) return
  const next = focusedTemplate()?.id ?? null
  if (next === focusedTemplateId) return
  focusedTemplateId = next
  queueRender()
}

let installed = false

const observe = (): void => {
  paletteMounted = document.querySelector(PALETTE_SWATCH) !== null
  if (paletteMounted) render()
  new MutationObserver((records) => {
    if (touchesPalette(records)) discoverPalette()
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
  })
}

/** Keep Wplace's transient swatches decorated across its Svelte drawer remounts. */
export const installPaintPaletteProgress = (): void => {
  if (installed) return
  installed = true
  onServerStatusChange(queueRender)
  pixelAccounting.onChange(queueRender)
  pixelAccounting.onDraftChange(queueRender)
  onAcceptedPaint((paint) => {
    const submitted = paint.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
    if (submitted > 0 && paint.painted === submitted) retainAcceptedDraft()
    queueRender()
  })
  onStateChange(queueRender)
  onLocalChange(queueRender)
  // This watcher already crosses the userscript/page realm reliably and fires when Wplace mounts
  // or replaces its drawer. Keep the local observer as a second line for same-selection remounts.
  onPaintSelectionChange(discoverPalette)
  if (document.documentElement === null) {
    document.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
}
