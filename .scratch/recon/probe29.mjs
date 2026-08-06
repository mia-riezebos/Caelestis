import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const K = ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements','clear','clearColor']
  window.__d = { atZoom11: {}, afterZoomOut: {}, phase: 'atZoom11' }
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    for (const k of K) {
      if (typeof gl[k] !== 'function') continue
      const f = gl[k].bind(gl)
      gl[k] = function (...a) {
        const b = window.__d[window.__d.phase]
        b[k] = (b[k] || 0) + 1
        return f(...a)
      }
    }
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
console.log('at zoom 11 :', JSON.stringify(await cdp.evaluate('window.__d.atZoom11')))

await cdp.evaluate(`window.__d.phase = 'afterZoomOut'`)
await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='-'); window.__minus=b })()`)
for (let i = 0; i < 3; i++) { await cdp.evaluate('window.__minus && window.__minus.click()'); await sleep(300) }
await sleep(1500)
console.log('during zoom-out:', JSON.stringify(await cdp.evaluate('window.__d.afterZoomOut')))
// Now sit completely still and see whether MapLibre renders at all.
await cdp.evaluate(`window.__d.settled = {}; window.__d.phase = 'settled'`)
await sleep(4000)
console.log('sitting still :', JSON.stringify(await cdp.evaluate('window.__d.settled')))
cdp.close(); await closeTab(tab.id)
