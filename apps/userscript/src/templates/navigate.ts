import { canvasPixelToLatLng, TILE_SIZE } from '@wts/shared'
import { log } from '../debug.js'

/**
 * Go to a place on the map.
 *
 * **In-game navigation is not available to us, and this was established by measurement rather than
 * assumed.** Three routes were tried against the live page:
 *
 * - *Drive MapLibre's camera* — the `Map` instance is unreachable; `10-recon-map-stack` records six
 *   routes to it, all dead.
 * - *Synthesise input* — a page script can dispatch `PointerEvent`s and `WheelEvent`s at MapLibre's
 *   canvas and the camera does not move. The same gestures delivered as real OS input move it
 *   immediately, so the events are being rejected for not being trusted, and no userscript can
 *   produce a trusted event.
 * - *History navigation* — `pushState` plus a `popstate` does not move it either; wplace syncs the
 *   map to the URL, not the URL to the map.
 *
 * So this changes the URL, which costs a page load. That is only acceptable because local templates
 * are persisted: the reload restores them, and an import survives being navigated to. Without that
 * persistence this would destroy the very thing it was showing you.
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

export const navigateTo = (target: NavigateTarget): void => {
  const { lat, lng } = canvasPixelToLatLng({ x: target.x, y: target.y })
  const zoom = zoomToFit(target.width, target.height)
  const url = new URL(window.location.href)
  url.searchParams.set('lat', lat.toFixed(7))
  url.searchParams.set('lng', lng.toFixed(7))
  url.searchParams.set('zoom', String(zoom))
  log('install', 'navigating', { lat, lng, zoom })
  window.location.href = url.toString()
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
