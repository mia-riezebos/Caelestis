import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { log } from './debug.js'

/**
 * Which colour wplace currently has selected, and whether its paint drawer is open at all.
 *
 * Read from their rendered swatches rather than from any state of theirs: each one is a
 * `<button id="color-N">`, and the selected one carries `ring-primary`. `color-N` is our palette
 * index `N - 1` — their array puts Transparent at 0 and ours puts it last — which is exact now that
 * the palette is read from their own bundle rather than a copy of it.
 *
 * The drawer existing *is* the signal that painting has started. There is no separate flag to read,
 * and there does not need to be: the swatches are only in the document while it is open.
 *
 * Watched with a MutationObserver because both facts change without navigation — the drawer is
 * mounted and unmounted by Svelte, and selecting a colour only rewrites one class.
 */

let selected: number | null = null
let open = false
const listeners: Array<() => void> = []

/** Our palette index of the colour wplace has selected, or null if none is. */
export const selectedColour = (): number | null => selected

/** Whether wplace's paint drawer is currently on screen. */
export const isPaintOpen = (): boolean => open

export const onPaintSelectionChange = (listener: () => void): void => {
  listeners.push(listener)
}

/**
 * `color-N` carries their array index, where 0 is Transparent and 1 is our 0.
 *
 * Transparent is deliberately not mapped to a selection. It is paintable for them, but as a
 * template colour it means "may be anything", so "show only the selected colour" has nothing to
 * show for it.
 */
const paletteIndexOf = (element: Element): number | null => {
  const raw = Number(element.id.slice('color-'.length))
  if (!Number.isInteger(raw) || raw <= 0) return null
  const index = raw - 1
  if (index < 0 || index >= PALETTE_SIZE || index === TRANSPARENT_INDEX) return null
  return index
}

const read = (): void => {
  const swatches = document.querySelectorAll('[id^="color-"]')
  const nextOpen = swatches.length > 0
  let nextSelected: number | null = null
  for (const swatch of swatches) {
    if (!swatch.className.includes('ring-primary')) continue
    nextSelected = paletteIndexOf(swatch)
    break
  }
  if (nextOpen === open && nextSelected === selected) return
  open = nextOpen
  selected = nextSelected
  log('install', 'paint selection changed', { open, selected })
  for (const listener of listeners) listener()
}

const observe = (): void => {
  read()
  const observer = new MutationObserver(read)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })
}

/**
 * Start watching, once there is anything to watch.
 *
 * This runs at `document-start`, which is earlier than it sounds: the script is evaluated before the
 * parser has created `<html>`, so **both `document.body` and `document.documentElement` are null**.
 * `observe(null)` throws, and since this is called from `main` the throw took the entry point with
 * it — the rail button simply never appeared, with nothing on screen to say why.
 *
 * Waiting costs nothing here. wplace's paint drawer cannot exist before its own scripts have run.
 */
export const watchPaintSelection = (): void => {
  if (document.documentElement !== null) {
    observe()
    return
  }
  document.addEventListener('DOMContentLoaded', observe, { once: true })
}
