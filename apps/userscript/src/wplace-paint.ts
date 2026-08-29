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

/** Select one of Wplace's own paint swatches without owning a second palette state. */
export const selectPaintColour = (index: number): boolean => {
  if (!Number.isInteger(index) || index < 0 || index >= TRANSPARENT_INDEX) return false
  const swatch = document.getElementById(`color-${index + 1}`)
  if (!(swatch instanceof HTMLElement)) return false
  swatch.click()
  return true
}

/**
 * Wplace's paint drawer close button has no label or title. Locate it from the native palette's
 * stable structure instead: palette swatch -> wrapper -> grid -> palette section -> drawer, then
 * the header containing its titled Undo control and the last direct button in that header. Keeping
 * this traversal here avoids teaching the shortcut controller about Wplace's DOM.
 */
const paintDrawerOf = (swatch: Element): HTMLElement | null => {
  const drawer = swatch.parentElement?.parentElement?.parentElement?.parentElement
  return drawer instanceof HTMLElement ? drawer : null
}

const paintDrawerCloseButton = (swatch: Element): HTMLButtonElement | null => {
  const drawer = paintDrawerOf(swatch)
  if (drawer === null) return null
  const header = Array.from(drawer.children).find(
    (child) => child.querySelector('button[title="Undo"]') !== null,
  )
  if (header === undefined) return null
  const directButtons = Array.from(header.children).filter(
    (child): child is HTMLButtonElement => child instanceof HTMLButtonElement,
  )
  return directButtons.at(-1) ?? null
}

/** Wplace's authoritative submit control inside the mounted paint drawer. */
const paintDrawerCommitButton = (swatch: Element): HTMLButtonElement | null => {
  const drawer = paintDrawerOf(swatch)
  if (drawer === null) return null
  for (const button of drawer.querySelectorAll<HTMLButtonElement>('button.btn-primary')) {
    const dock = button.parentElement
    if (
      dock?.classList.contains('absolute') === true &&
      dock.classList.contains('bottom-0') &&
      dock.classList.contains('left-1/2') &&
      dock.classList.contains('-translate-x-1/2') &&
      button.textContent?.trim().toLowerCase().startsWith('paint') === true
    ) {
      return button
    }
  }
  return null
}

/**
 * Ask Wplace's own paint drawer to move through its authoritative draft history.
 *
 * The native controls own pixel recency, redo invalidation after a new paint, and the draft payload
 * eventually submitted to Wplace. Driving those controls keeps all of that state in one place; the
 * resulting canvas writes then flow through our canonical pixel-accounting interception exactly
 * like a hand-painted pixel.
 */
const movePaintHistory = (title: 'Undo' | 'Redo'): boolean => {
  const swatch = document.querySelector('[id^="color-"]')
  if (swatch === null) return false
  const drawer = paintDrawerOf(swatch)
  if (drawer === null) return false
  const button = drawer.querySelector(`button[title="${title}"]`)
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false
  button.click()
  return true
}

/** Undo the most recently drafted pixel, if Wplace currently has one. */
export const undoPaintDraft = (): boolean => movePaintHistory('Undo')

/** Redo the most recently undone draft pixel, if Wplace currently has one. */
export const redoPaintDraft = (): boolean => movePaintHistory('Redo')

const paintDockButton = (): HTMLButtonElement | null => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button.btn-primary')) {
    const dock = button.parentElement
    if (
      dock?.classList.contains('absolute') === true &&
      dock.classList.contains('bottom-3') &&
      dock.classList.contains('left-1/2') &&
      dock.classList.contains('z-30') &&
      dock.classList.contains('-translate-x-1/2')
    ) {
      return button
    }
  }
  return null
}

/**
 * Open Wplace's paint mode, or submit its current draft when it is already open. Prefer an exact
 * accessible label for opening, then the current structurally unique bottom-centre primary control.
 * The latter is needed because Wplace's live Paint button has dynamic timer text but no aria-label
 * or title. Neither path searches arbitrary page text, so a template action or dialog button cannot
 * be mistaken for paint mode.
 */
export const performPaintAction = (): boolean => {
  const swatch = document.querySelector('[id^="color-"]')
  if (swatch !== null) {
    const commit = paintDrawerCommitButton(swatch)
    if (commit === null || commit.disabled) return false
    commit.click()
    return true
  }
  const labels = new Set(['paint', 'open paint', 'paint pixel'])
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
    const label = (button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '')
      .trim()
      .toLowerCase()
    if (!labels.has(label)) continue
    button.click()
    return true
  }
  const dockButton = paintDockButton()
  if (dockButton !== null) {
    dockButton.click()
    return true
  }
  return false
}

/** Discard the current native Wplace draft, leaving unrelated Escape handling alone when closed. */
export const cancelPaintDraft = (): boolean => {
  const swatch = document.querySelector('[id^="color-"]')
  if (swatch === null) return false
  const close = paintDrawerCloseButton(swatch)
  if (close === null || close.disabled) return false
  close.click()
  return true
}

/** Toggle Wplace's own theme state through the exact native control kept in its settings DOM. */
export const toggleWplaceTheme = (): boolean => {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Dark mode"], button[aria-label="Light mode"]',
  )
  if (button === null || button.disabled) return false
  button.click()
  return true
}

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

/**
 * Once per frame, not once per mutation batch.
 *
 * `read` scans the whole document for `[id^="color-"]`, which is an unindexed attribute-prefix
 * match, and wplace's own app re-renders its chrome continuously — so the unbatched version ran a
 * full-document scan on every one of its mutations. The rail observer in `panel.ts` was fixed the
 * same way for the same actor. Nothing is lost: opening a drawer and picking a colour happen on
 * human timescales, and a frame is far finer than that.
 */
let queued = false

const queueRead = (): void => {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    read()
  })
}

const observe = (): void => {
  read()
  const observer = new MutationObserver(queueRead)
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
