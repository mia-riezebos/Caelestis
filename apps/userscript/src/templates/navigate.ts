import { canvasPixelToLatLng, TILE_SIZE } from '@wts/shared'
import { log } from '../debug.js'
import { getMap } from '../map-handle.js'

/**
 * Go to a place on the map, in-game.
 *
 * We hold a live MapLibre `Map` — see `map-handle.ts` for how, and for the four routes that failed
 * first — so this is `flyTo`, not a page load. Everything in memory survives, which matters most
 * immediately after an import.
 *
 * `cameraForBounds` gives fit-to-extent for free, so a template is framed rather than merely
 * centred. The URL remains as a fallback for the case where the capture did not fire.
 */

const MIN_ZOOM = 11
const MAX_ZOOM = 20
/** Measured: one tile spans 512 CSS pixels at zoom 11, doubling per level. */
const TILE_CSS_AT_ZOOM_11 = 512

export interface NavigateTarget {
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
}

/**
 * Zoom that fits `width x height`, never below 11.
 *
 * Below roughly 10.6 wplace stops serving tiles at all, so fitting a very large template by zooming
 * out past that would frame it against nothing.
 */
const zoomToFit = (width?: number, height?: number): number => {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return 13
  // A margin, so the template is framed rather than bleeding off every edge.
  const usableWidth = window.innerWidth * 0.8
  const usableHeight = window.innerHeight * 0.8
  const fit = Math.min(
    usableWidth / ((width / TILE_SIZE) * TILE_CSS_AT_ZOOM_11),
    usableHeight / ((height / TILE_SIZE) * TILE_CSS_AT_ZOOM_11),
  )
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, MIN_ZOOM + Math.log2(fit)))
}

export const navigateTo = (target: NavigateTarget): void => {
  const { lat, lng } = canvasPixelToLatLng({ x: target.x, y: target.y })
  const zoom = zoomToFit(target.width, target.height)
  const map = getMap()

  if (map !== null) {
    const distance = Math.hypot(lng - map.getCenter().lng, lat - map.getCenter().lat)
    log('install', 'moving the camera', { lat, lng, zoom, distance: Math.round(distance) })
    // `flyTo` arcs out and back in, which is charming over a few streets and interminable across
    // the world — a cross-globe flight was still climbing after six seconds, with the map below the
    // zoom where wplace serves tiles at all, so the destination showed as empty. Long hops jump.
    if (distance > 5) map.jumpTo({ center: [lng, lat], zoom })
    else map.flyTo({ center: [lng, lat], zoom, duration: 700 })
    return
  }

  // No map handle: fall back to the URL. This reloads, which is only survivable because local
  // templates persist.
  log('install', 'no map handle, falling back to the URL', { lat, lng, zoom })
  const url = new URL(window.location.href)
  url.searchParams.set('lat', lat.toFixed(7))
  url.searchParams.set('lng', lng.toFixed(7))
  url.searchParams.set('zoom', zoom.toFixed(2))
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
