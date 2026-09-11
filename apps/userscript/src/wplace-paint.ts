import { PALETTE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { activeAllianceEditorStage } from './alliance-surface.js'
import { log } from './debug.js'

/**
 * Which colour wplace currently has selected, and whether its paint drawer is open at all.
 *
 * Read from their rendered swatches rather than from any state of theirs. World swatches use
 * `color-N` and `ring-primary`. Alliance swatches use their colour name and `aria-pressed`.
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
  const root = activePaintRoot()
  const swatch =
    root.querySelector<HTMLElement>(`#color-${index + 1}`) ??
    alliancePaletteSwatches(root).find((candidate) => paintPaletteIndexOf(candidate) === index)
  if (!(swatch instanceof HTMLElement)) return false
  swatch.click()
  return true
}

const paintControl = (
  root: ParentNode,
  label: 'Undo' | 'Redo' | 'Close',
): HTMLButtonElement | null =>
  root.querySelector(`button[aria-label="${label}"], button[title="${label}"]`)

/** Find the smallest palette ancestor containing native history controls, within the active root. */
const paintDrawerOf = (swatch: Element, root: ParentNode): HTMLElement | null => {
  for (let drawer = swatch.parentElement; drawer !== null; drawer = drawer.parentElement) {
    if (drawer === document.body || drawer === document.documentElement) return null
    if (paintControl(drawer, 'Undo') !== null && paintControl(drawer, 'Redo') !== null)
      return drawer
    if (drawer === root) return null
  }
  return null
}

/** Prefer native Close labels; retain the unlabeled header control used by older Wplace drawers. */
const paintDrawerCloseButton = (drawer: HTMLElement): HTMLButtonElement | null => {
  const close = paintControl(drawer, 'Close')
  if (close !== null) return close
  const header = Array.from(drawer.children).find(
    (child) => child.querySelector('button[title="Undo"]') !== null,
  )
  if (header === undefined) return null
  const directButtons = Array.from(header.children).filter(
    (child): child is HTMLButtonElement =>
      child instanceof HTMLButtonElement &&
      !child.hasAttribute('title') &&
      !child.hasAttribute('aria-label') &&
      child.textContent?.trim() === '',
  )
  return directButtons.length === 1 ? (directButtons[0] ?? null) : null
}

/** Match only the drawer's Paint action, including its optional countdown, without layout classes. */
const paintDrawerCommitButton = (drawer: HTMLElement): HTMLButtonElement | null => {
  const candidates = [...drawer.querySelectorAll<HTMLButtonElement>('button')].filter((button) => {
    const label =
      button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent
    return /^paint(?:\s*\([^)]*\))?$/i.test(label?.trim() ?? '')
  })
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

/**
 * Ask Wplace's own paint drawer to move through its authoritative draft history.
 *
 * The native controls own pixel recency, redo invalidation after a new paint, and the draft payload
 * eventually submitted to Wplace. Driving those controls keeps all of that state in one place; the
 * resulting canvas writes then flow through our canonical pixel-accounting interception exactly
 * like a hand-painted pixel.
 */
const movePaintHistory = (title: 'Undo' | 'Redo', root: ParentNode): boolean => {
  const drawer = nativePaintPanel(root)
  const button = drawer === null ? null : paintControl(drawer, title)
  if (button === null || button.disabled) return false
  button.click()
  return true
}

/** Undo the most recently drafted pixel, if Wplace currently has one. */
export const undoPaintDraft = (root: ParentNode = document): boolean =>
  movePaintHistory('Undo', root)

/** Redo the most recently undone draft pixel, if Wplace currently has one. */
export const redoPaintDraft = (root: ParentNode = document): boolean =>
  movePaintHistory('Redo', root)

const paintDockButton = (root: ParentNode): HTMLButtonElement | null => {
  let visiblePaint: HTMLButtonElement | null = null
  for (const button of root.querySelectorAll<HTMLButtonElement>('button.btn-primary')) {
    const dock = button.parentElement
    if (
      dock?.classList.contains('absolute') === true &&
      dock.classList.contains('left-1/2') &&
      dock.classList.contains('-translate-x-1/2') &&
      (dock.classList.contains('bottom-3') || dock.classList.contains('bottom-14')) &&
      button.textContent?.trim().toLowerCase().startsWith('paint') === true
    ) {
      return button
    }
    const rect = button.getBoundingClientRect()
    if (
      visiblePaint === null &&
      rect.width > 0 &&
      rect.height > 0 &&
      button.classList.contains('btn-lg') &&
      button.textContent?.trim().toLowerCase().startsWith('paint') === true
    ) {
      visiblePaint = button
    }
  }
  return visiblePaint
}

/**
 * Open Wplace's paint mode, or submit through the palette's own panel when it is already open.
 * Opening prefers an exact accessible label, then the native dock control. A mounted palette whose
 * controls cannot be identified must not fall through to an unrelated action elsewhere on the page.
 */
export const performPaintAction = (root: ParentNode = document): boolean => {
  if (paintPaletteSwatches(root).length > 0) {
    const drawer = nativePaintPanel(root)
    const commit = drawer === null ? null : paintDrawerCommitButton(drawer)
    if (commit === null || commit.disabled) return false
    commit.click()
    return true
  }
  const labels = new Set(['paint', 'open paint', 'paint pixel'])
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const label = (button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '')
      .trim()
      .toLowerCase()
    if (!labels.has(label)) continue
    button.click()
    return true
  }
  const dockButton = paintDockButton(root)
  if (dockButton !== null) {
    dockButton.click()
    return true
  }
  return false
}

/** Discard the current native Wplace draft, leaving unrelated Escape handling alone when closed. */
export const cancelPaintDraft = (root: ParentNode = document): boolean => {
  const drawer = nativePaintPanel(root)
  const close = drawer === null ? null : paintDrawerCloseButton(drawer)
  if (close === null || close.disabled) return false
  close.click()
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
export const paintPaletteIndexOf = (element: Element): number | null => {
  const raw = Number(element.id.slice('color-'.length))
  const label = element.getAttribute('aria-label')?.split('. ', 1)[0]?.toLowerCase()
  const index =
    Number.isInteger(raw) && raw > 0
      ? raw - 1
      : (WPLACE_PALETTE.find((colour) => colour.name.toLowerCase() === label)?.index ?? -1)
  if (index < 0 || index >= PALETTE_SIZE || index === TRANSPARENT_INDEX) return null
  return index
}

const alliancePaletteSwatches = (root: ParentNode): HTMLButtonElement[] =>
  [...root.querySelectorAll<HTMLButtonElement>('button[aria-label][aria-pressed]')].filter(
    (button) =>
      paintPaletteIndexOf(button) !== null || button.getAttribute('aria-label') === 'Transparent',
  )

const activePaintRoot = (): ParentNode =>
  activeAllianceEditorStage()?.closest('dialog[open]') ?? document

/** Wplace's mounted world or alliance paint swatches, in their rendered order. */
export const paintPaletteSwatches = (root: ParentNode = activePaintRoot()): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[id^="color-"]'),
  ...alliancePaletteSwatches(root),
]

const nativePaintPanel = (root: ParentNode): HTMLElement | null => {
  const swatch = paintPaletteSwatches(root)[0]
  return swatch === undefined ? null : paintDrawerOf(swatch, root)
}

const read = (): void => {
  const swatches = paintPaletteSwatches()
  const nextOpen = swatches.length > 0
  let nextSelected: number | null = null
  for (const swatch of swatches) {
    if (
      !swatch.className.includes('ring-primary') &&
      swatch.getAttribute('aria-pressed') !== 'true'
    )
      continue
    nextSelected = paintPaletteIndexOf(swatch)
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
    attributeFilter: ['class', 'aria-pressed'],
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
