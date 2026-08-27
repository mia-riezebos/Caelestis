import { latLngToCanvasPixel, PALETTE_SIZE } from '@caelestis/shared'
import { count, warn } from './debug.js'
import { getMap } from './map-handle.js'
import { type ConnectedServer, getState, onStateChange } from './state.js'
import { onServerStatusChange, serverColourProgressFor } from './telemetry.js'
import {
  displayTemplates,
  isTemplateVisible,
  onLocalChange,
  type PlacedTemplate,
} from './templates/local-store.js'
import {
  colourProgressFor,
  nearestColourTarget,
  onMismatchesChanged,
  type TemplateColourProgress,
} from './templates/mismatch.js'
import { navigateTo } from './templates/navigate.js'
import { templateAtCentre } from './templates/nearest.js'
import { freshestColourProgress, sumColourProgress } from './ui/progress.js'
import { onPaintSelectionChange } from './wplace-paint.js'

/**
 * Per-colour progress for one template where Wplace's own paint controls are used.
 *
 * Local overlays have no server and therefore use their retained client scan. Server overlays use
 * the server as their complete baseline, then replace any colour this browser has fully classified
 * so a fresh local paint does not wait for the telemetry round trip.
 */
const connectedServers = (): ReadonlyMap<string, ConnectedServer> =>
  new Map(getState().servers.map((server) => [server.url, server]))

const progressForTemplate = (
  template: PlacedTemplate | null,
  servers: ReadonlyMap<string, ConnectedServer> = connectedServers(),
): readonly TemplateColourProgress[] => {
  if (template === null) return []
  if (template.serverUrl === undefined || template.serverTemplateId === undefined)
    return colourProgressFor(template)
  const server = servers.get(template.serverUrl)
  if (server === undefined) return []
  // The drawn template already proves the manifest identity and exact pixel total. Depending on the
  // panel's admitted manifest here made palette counters disappear whenever Paint opened before the
  // main menu had rendered its tree.
  const progress = serverColourProgressFor(server, {
    id: template.serverTemplateId,
    totalPixels: template.opaque,
  })
  return progress === null ? [] : freshestColourProgress(progress, colourProgressFor(template))
}

/** The colour counts decorating Wplace's palette belong only to what the viewport is focused on. */
export const paintPaletteProgress = (): readonly TemplateColourProgress[] =>
  progressForTemplate(templateAtCentre())

/** Navigation still ranges over every visible template; focusing the badge must not narrow the tool. */
const navigationProgress = (): readonly TemplateColourProgress[] => {
  const servers = connectedServers()
  const groups: Array<readonly TemplateColourProgress[]> = []
  for (const template of displayTemplates()) {
    if (!isTemplateVisible(template)) continue
    const progress = progressForTemplate(template, servers)
    if (progress.length > 0) groups.push(progress)
  }
  return sumColourProgress(groups) ?? []
}

const paletteIndexOf = (element: Element): number | null => {
  const raw = Number(element.id.slice('color-'.length))
  const index = raw - 1
  return Number.isInteger(raw) && raw > 0 && index < PALETTE_SIZE ? index : null
}

const originalLabels = new WeakMap<HTMLElement, string>()
const wired = new WeakSet<HTMLElement>()
const PALETTE_SWATCH = '[id^="color-"]'

const goToColour = async (index: number): Promise<void> => {
  const progress = navigationProgress().find((entry) => entry.index === index)
  if (progress === undefined || progress.unpainted === 0) return
  const map = getMap()
  if (map === null) return
  const reference = latLngToCanvasPixel(map.getCenter())
  const target = await nearestColourTarget(index, 'unpainted', reference)
  if (target === null) {
    warn('install', `no loaded unpainted pixel for palette colour ${index}`)
    return
  }
  navigateTo({ x: target.x + 0.5, y: target.y + 0.5, width: 1, height: 1 })
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
    void goToColour(index)
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
  count('paint:palette progress colours', progress.size)
  for (const element of swatches) {
    const index = paletteIndexOf(element)
    if (index === null) continue
    wire(element, index)
    const entry = progress.get(index)
    const existing = element.querySelector<HTMLElement>(':scope > .caelestis-palette-progress')
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
      `${label}. ${remaining.toLocaleString()} ${remaining === 1 ? 'pixel' : 'pixels'} left in the focused template. Middle-click to go to the nearest unpainted pixel.`,
    )
    const badge = existing ?? document.createElement('span')
    badge.className = 'caelestis-palette-progress'
    badge.setAttribute('aria-hidden', 'true')
    const text = remaining.toLocaleString()
    if (badge.textContent !== text) badge.textContent = text
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
  const next = templateAtCentre()?.id ?? null
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
  onMismatchesChanged(queueRender)
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
