import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
// Installed at document-start, exactly as a userscript would.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  window.__cap = { hits: [] }
  // MapLibre's Map assigns these to itself during construction. A setter on Object.prototype sees
  // the assignment and, crucially, sees \`this\` — which is the Map.
  for (const prop of ['_canvasContainer', '_controlContainer', '_canvas']) {
    Object.defineProperty(Object.prototype, prop, {
      configurable: true,
      set(value) {
        if (this && typeof this.flyTo === 'function' && !window.__map) {
          window.__map = this
          window.__cap.hits.push(prop)
        }
        // Hand the assignment back to the object so nothing downstream notices.
        Object.defineProperty(this, prop, {
          value, writable: true, configurable: true, enumerable: true,
        })
      },
      get() { return undefined },
    })
  }
  // Take the traps off Object.prototype the moment we have what we came for.
  const release = () => {
    if (!window.__map) return
    for (const prop of ['_canvasContainer', '_controlContainer', '_canvas']) {
      const d = Object.getOwnPropertyDescriptor(Object.prototype, prop)
      if (d && d.set) delete Object.prototype[prop]
    }
    clearInterval(timer)
  }
  const timer = setInterval(release, 50)
})()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(12000)
const ev = (js) => cdp.evaluate(js)
console.log('captured via  :', await ev("JSON.stringify(window.__cap.hits)"))
console.log('is a map      :', await ev("typeof window.__map?.flyTo === 'function'"))
console.log('zoom          :', await ev("window.__map?.getZoom?.() ?? 'n/a'"))
console.log('centre        :', await ev("JSON.stringify(window.__map?.getCenter?.() ?? null)"))
console.log('prototype clean:', await ev("!Object.getOwnPropertyDescriptor(Object.prototype,'_canvas')"))

// The whole point: fly somewhere and confirm the camera actually went.
console.log('is the live map:', await ev("window.__map.getCanvas?.() === document.querySelector('canvas.maplibregl-canvas')"))
console.log('loaded / style :', await ev("String(window.__map.loaded?.()) + ' / ' + String(!!window.__map.getStyle?.())"))
console.log('canvas size    :', await ev("(() => { const c = window.__map.getCanvas?.(); return c ? c.width + 'x' + c.height : 'none' })()"))
const before = await ev("JSON.stringify(window.__map?.getCenter?.() ?? null)")
// flyTo returns the map; returning that to CDP blows up on serialisation.
await ev("(() => { window.__map.flyTo({ center: [2.3522, 48.8566], zoom: 14, duration: 800 }); return 'flying' })()")
await sleep(1000)
console.log('mid-flight     :', await ev("JSON.stringify(window.__map?.getCenter?.() ?? null)"))
console.log('jumpTo instead :', await ev("(() => { try { window.__map.jumpTo({ center: [2.3522, 48.8566], zoom: 14 }); return 'ok' } catch (e) { return 'threw: ' + e.message } })()"))
await sleep(2500)
console.log('centre before :', before)
console.log('centre after  :', await ev("JSON.stringify(window.__map?.getCenter?.() ?? null)"))
console.log('zoom after    :', await ev("window.__map?.getZoom?.() ?? 'n/a'"))
console.log('url now       :', (await ev("location.href")).slice(0, 70))
cdp.close(); await closeTab(tab.id)
