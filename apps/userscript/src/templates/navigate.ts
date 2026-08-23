import { canvasPixelToLatLng, TILE_SIZE } from '@caelestis/shared'
import { log } from '../debug.js'
import { getMap } from '../map-handle.js'
import { horizontalCentre } from './placement.js'

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
    try {
      if (map.getCanvas().isConnected) {
        log('install', 'flying', { lat, lng, zoom })
        map.flyTo({ center: [lng, lat], zoom })
        return
      }
      log('install', 'captured map is detached, falling back to the URL')
    } catch (error) {
      // MapLibre can be torn down between the connectivity check and flyTo during an SPA remount.
      log('install', 'captured map failed, falling back to the URL', String(error))
    }
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
  wrapX?: boolean
}): NavigateTarget => ({
  x: horizontalCentre(t),
  y: t.originY + t.height / 2,
  width: t.width,
  height: t.height,
})
