import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const isMap = (o) => o && typeof o === 'object' &&
    typeof o.getCanvas === 'function' && typeof o.triggerRepaint === 'function'
  window.__cap = { viaBind: null, viaRaf: null, binds: 0, mapLike: [] }

  // 1. Function.prototype.bind leaks its thisArg. MapLibre binds methods to the Map.
  const nativeBind = Function.prototype.bind
  Function.prototype.bind = function (thisArg, ...rest) {
    window.__cap.binds++
    try {
      if (isMap(thisArg) && !window.__cap.viaBind) {
        window.__cap.viaBind = thisArg
        window.__map = thisArg
      }
    } catch {}
    return nativeBind.call(this, thisArg, ...rest)
  }

  // 2. Some builds bind nothing; the render loop still runs a closure. Sweep rAF callbacks for
  //    a bound/own reference instead.
  const nativeRaf = window.requestAnimationFrame
  window.requestAnimationFrame = function (cb) {
    try {
      if (!window.__cap.viaRaf && cb) {
        for (const k of Object.getOwnPropertyNames(cb)) {
          const v = cb[k]
          if (isMap(v)) { window.__cap.viaRaf = v; window.__map = window.__map || v }
        }
      }
    } catch {}
    return nativeRaf.call(this, cb)
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const out = await cdp.evaluate(`(() => {
  const m = window.__map
  if (!m) return { captured: false, binds: window.__cap.binds }
  return {
    captured: true,
    binds: window.__cap.binds,
    via: window.__cap.viaBind ? 'Function.prototype.bind' : 'requestAnimationFrame',
    center: m.getCenter && m.getCenter(),
    zoom: m.getZoom && m.getZoom(),
    bearing: m.getBearing && m.getBearing(),
    pitch: m.getPitch && m.getPitch(),
    canAddLayer: typeof m.addLayer === 'function',
    canProject: typeof m.project === 'function',
    styleLayers: m.getStyle && m.getStyle().layers ? m.getStyle().layers.length : null,
    // The two calls an overlay actually needs.
    projectTest: m.project ? m.project([4.90, 52.37]) : null,
    version: m.version || null,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
