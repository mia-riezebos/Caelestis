import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(12000)
const ev = (js) => cdp.evaluate(js)
const CAMERA = 'https://wplace.live/_app/immutable/nodes/5.DyfU_jM8.js'

console.log('exports carrying a Map-like prototype:')
console.log(await ev(`(async () => {
  const m = await import(${JSON.stringify(CAMERA)})
  const hits = []
  for (const [k, v] of Object.entries(m)) {
    const proto = typeof v === 'function' ? v.prototype : null
    if (proto && typeof proto.flyTo === 'function') hits.push(k + ' (class with flyTo)')
    else if (proto && typeof proto.getZoom === 'function') hits.push(k + ' (class with getZoom)')
  }
  return hits.join(' | ') || 'none — ' + Object.keys(m).length + ' exports: ' + Object.keys(m).slice(0,20).join(',')
})()`))

// If the class is reachable, patch a per-frame method to catch the live instance.
console.log('\ncapture attempt:')
console.log(await ev(`(async () => {
  const m = await import(${JSON.stringify(CAMERA)})
  for (const [k, v] of Object.entries(m)) {
    const proto = typeof v === 'function' ? v.prototype : null
    if (!proto || typeof proto.flyTo !== 'function') continue
    // _render runs every frame; triggerRepaint is close behind. Either yields \`this\`.
    for (const name of ['_render', 'triggerRepaint', '_requestRenderFrame', 'getZoom']) {
      if (typeof proto[name] !== 'function') continue
      const native = proto[name]
      proto[name] = function (...args) { globalThis.__map = this; return native.apply(this, args) }
      return 'patched ' + k + '.prototype.' + name
    }
  }
  return 'no patchable class'
})()`))
await sleep(3000)
console.log('captured?      :', await ev("typeof globalThis.__map?.flyTo === 'function'"))
console.log('zoom via map   :', await ev("globalThis.__map?.getZoom?.() ?? 'n/a'"))
console.log('centre via map :', await ev("JSON.stringify(globalThis.__map?.getCenter?.() ?? null)"))
cdp.close(); await closeTab(tab.id)
