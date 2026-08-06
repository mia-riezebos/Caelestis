import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const probe = await cdp.evaluate(`(() => {
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    cls: c.className, w: c.width, h: c.height,
    ctx: (() => { try { return c.getContext('webgl2') ? 'webgl2-live' : 'not-webgl2' } catch { return 'err' } })(),
    parentCls: c.parentElement && c.parentElement.className,
  }))
  const globals = Object.keys(window).filter((k) =>
    /maplibre|mapbox|leaflet|^L$|deck|openlayers|^ol$/i.test(k))
  // MapLibre stamps its canvas container and adds a control attribution link.
  const attribution = [...document.querySelectorAll('a')]
    .map((a) => a.href).filter((h) => /maplibre|openfreemap|openstreetmap/i.test(h))
  return {
    canvases,
    globals,
    attribution: [...new Set(attribution)],
    maplibreClasses: [...new Set([...document.querySelectorAll('[class*="maplibre"]')]
      .map((e) => e.className.toString()))].slice(0, 12),
    hasMaplibreCanvasContainer: !!document.querySelector('.maplibregl-canvas-container'),
    svelteKit: !!document.querySelector('[data-sveltekit-preload-data], #svelte'),
  }
})()`)
console.log(JSON.stringify(probe, null, 2))
cdp.close()
await closeTab(tab.id)
