import { canvasPixelToLatLng, TILE_SIZE } from '@wts/shared'
import { log } from '../debug.js'

/**
 * Go to a place on the map.
 *
 * **In-game, by driving wplace's own Search.** Their search box accepts a coordinate pair and
 * offers it as a "Coordinates" result; picking that flies the camera with no page load. That is the
 * only route that works, and it was found by opening the dialog and looking rather than by
 * reasoning about it.
 *
 * The routes that do not work, each measured against the live page:
 *
 * - *Drive MapLibre's camera* — the `Map` instance is unreachable; `10-recon-map-stack` lists six
 *   routes to it, all dead.
 * - *Synthesise map input* — page-dispatched `PointerEvent`s and `WheelEvent`s leave the camera
 *   still, while the same gestures as real OS input move it immediately. Nothing a userscript can
 *   dispatch is trusted.
 * - *History navigation* — `pushState` plus `popstate` does nothing; wplace syncs the map to the
 *   URL, never the other way.
 *
 * Clicking their buttons *does* work, because those are ordinary DOM listeners rather than pointer
 * gestures — which is what makes this route viable when direct input is not.
 *
 * Setting the URL remains as a fallback, and costs a page load. It is survivable only because local
 * templates persist.
 */

/** Measured: one tile spans 512 CSS pixels at zoom 11, doubling per level. */
const TILE_CSS_AT_ZOOM_11 = 512
const MIN_ZOOM = 11
const MAX_ZOOM = 20

export interface NavigateTarget {
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
}

/**
 * The zoom that fits `width x height` on screen, never below 11.
 *
 * Below roughly 10.6 wplace stops serving tiles at all, so fitting a very large template by zooming
 * out past that would frame it against nothing.
 */
const zoomToFit = (width?: number, height?: number): number => {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return 13
  // Leave a margin so the template is framed rather than bleeding off every edge.
  const usableWidth = window.innerWidth * 0.8
  const usableHeight = window.innerHeight * 0.8
  const tilesWide = width / TILE_SIZE
  const tilesHigh = height / TILE_SIZE
  const fit = Math.min(
    usableWidth / (tilesWide * TILE_CSS_AT_ZOOM_11),
    usableHeight / (tilesHigh * TILE_CSS_AT_ZOOM_11),
  )
  const zoom = MIN_ZOOM + Math.log2(fit)
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100))
}

const settle = async (predicate: () => boolean, tries = 40): Promise<boolean> => {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** Svelte binds through the value setter, so assigning `.value` directly is not seen. */
const setNativeValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const searchField = (): HTMLInputElement | null => {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input')]
  return (
    inputs.find(
      (input) => (input.placeholder ?? '').trim() === 'Search' && input.offsetParent !== null,
    ) ?? null
  )
}

/**
 * Navigate through wplace's own Search dialog, without showing it.
 *
 * Their dialog is the only thing that can move the camera from here, but nobody should have to watch
 * it open, fill itself in and close again — that is our plumbing, not their journey. So it is hidden
 * for the fraction of a second it takes to drive, and dismissed afterwards.
 *
 * Hiding is a stylesheet rather than an inline style on the element, because the element is Svelte's
 * and it re-renders; a rule keyed on a class we add outlives that.
 */
const HIDE_ID = 'wts-hide-search'

const hideDialogs = (on: boolean): void => {
  const existing = document.getElementById(HIDE_ID)
  if (!on) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  const style = document.createElement('style')
  style.id = HIDE_ID
  // Suppress the dialog and its backdrop only; everything else on the page is untouched.
  style.textContent =
    '.modal, .modal-box, .modal-backdrop { opacity: 0 !important; pointer-events: none !important; }'
  document.head.appendChild(style)
}

const closeDialog = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const close = [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.title ?? '').trim() === 'Close',
  )
  close?.click()
}

export const navigateInGame = async (lat: number, lng: number): Promise<boolean> => {
  const open = [...document.querySelectorAll('button')].find(
    (button) => (button.title ?? '').trim() === 'Search',
  )
  if (open === undefined) return false

  hideDialogs(true)
  try {
    open.click()
    if (!(await settle(() => searchField() !== null))) return false

    const field = searchField()
    if (field === null) return false
    setNativeValue(field, `${lat.toFixed(6)}, ${lng.toFixed(6)}`)

    // Their coordinate result is labelled as such; anything else is a place-name match.
    let result: HTMLElement | null = null
    const found = await settle(() => {
      result =
        [...document.querySelectorAll<HTMLElement>('li, button, [role="option"]')].find(
          (element) =>
            /coordinates/i.test(element.textContent ?? '') && element.offsetParent !== null,
        ) ?? null
      return result !== null
    })
    if (!found || result === null) return false
    ;(result as HTMLElement).click()
    log('install', 'navigated in-game', { lat, lng })
    // Give their fly-to a moment to start before the dialog is torn away from under it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    closeDialog()
    return true
  } finally {
    // Whatever happened, the page must not be left with its dialogs invisible.
    setTimeout(() => hideDialogs(false), 400)
  }
}

export const navigateTo = (target: NavigateTarget): void => {
  const { lat, lng } = canvasPixelToLatLng({ x: target.x, y: target.y })
  const zoom = zoomToFit(target.width, target.height)
  const url = new URL(window.location.href)
  url.searchParams.set('lat', lat.toFixed(7))
  url.searchParams.set('lng', lng.toFixed(7))
  url.searchParams.set('zoom', String(zoom))
  void (async () => {
    // Their dialog first: it moves the camera without a reload, which keeps everything in memory.
    if (await navigateInGame(lat, lng)) return
    log('install', 'in-game navigation unavailable, falling back to the URL', { lat, lng, zoom })
    window.location.href = url.toString()
  })()
}

/** Centre of a template, with its extent, so navigation can frame the whole thing. */
export const centreOf = (t: {
  originX: number
  originY: number
  width: number
  height: number
}): NavigateTarget => ({
  x: t.originX + t.width / 2,
  y: t.originY + t.height / 2,
  width: t.width,
  height: t.height,
})
