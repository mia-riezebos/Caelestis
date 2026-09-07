import { activeAllianceSurface } from './alliance-surface.js'
import { userscriptVersion } from './client-metrics.js'
import { getMap } from './map-handle.js'
import { isTemplateVisible, localTemplates } from './templates/local-store.js'
import { isPaintOpen, selectedColour } from './wplace-paint.js'

declare const __CAELESTIS_BUILD__: {
  readonly revision: string | null
  readonly dirty: boolean | null
  readonly development: boolean
}

/** Read report metadata on demand; no environment probes run in the render loop. */
export const readProfileContext = () => {
  const map = getMap()
  const center = map?.getCenter()
  const templates = localTemplates()
  const navigator = globalThis.navigator as
    | (Navigator & { readonly deviceMemory?: number })
    | undefined
  const window = globalThis.window
  return {
    build: {
      version: userscriptVersion,
      ...(typeof __CAELESTIS_BUILD__ === 'undefined'
        ? { revision: null, dirty: null, development: true }
        : __CAELESTIS_BUILD__),
    },
    environment: {
      userAgent: navigator?.userAgent ?? null,
      platform: navigator?.platform ?? null,
      hardwareConcurrency: navigator?.hardwareConcurrency ?? null,
      deviceMemoryGiB: navigator?.deviceMemory ?? null,
      devicePixelRatio: window?.devicePixelRatio ?? null,
      viewport: window ? { width: window.innerWidth, height: window.innerHeight } : null,
      screen: window ? { width: window.screen.width, height: window.screen.height } : null,
      visualViewportScale: window?.visualViewport?.scale ?? null,
      visibility: globalThis.document?.visibilityState ?? null,
    },
    camera: center ? { longitude: center.lng, latitude: center.lat, zoom: map?.getZoom() } : null,
    surface: activeAllianceSurface()?.surface.kind ?? 'world',
    templates: {
      loaded: templates.length,
      enabled: templates.filter((template) => template.visible).length,
      drawing: templates.filter(isTemplateVisible).length,
    },
    paint: { open: isPaintOpen(), selectedColour: selectedColour() },
  }
}

export type ProfileContext = ReturnType<typeof readProfileContext>
