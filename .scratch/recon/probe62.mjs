import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  window.__f = { params: [], mipmaps: 0, tileTex: 0 }
  const NAMES = { 9728: 'NEAREST', 9729: 'LINEAR', 9984: 'NEAREST_MIPMAP_NEAREST', 9985: 'LINEAR_MIPMAP_NEAREST',
                  9986: 'NEAREST_MIPMAP_LINEAR', 9987: 'LINEAR_MIPMAP_LINEAR', 10240: 'MAG_FILTER', 10241: 'MIN_FILTER',
                  10242: 'WRAP_S', 10243: 'WRAP_T', 33071: 'CLAMP_TO_EDGE' }
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    let bound = null
    const tiles = new WeakSet()
    const nBT = gl.bindTexture.bind(gl); gl.bindTexture = (tg, tx) => { bound = tx; return nBT(tg, tx) }
    const nTI = gl.texImage2D.bind(gl)
    gl.texImage2D = function (...a) {
      const s = a[a.length - 1]
      if (bound && s instanceof ImageBitmap && s.width === 1000) { tiles.add(bound); window.__f.tileTex++ }
      return nTI(...a)
    }
    const nTP = gl.texParameteri.bind(gl)
    gl.texParameteri = function (target, pname, param) {
      if (bound && tiles.has(bound)) {
        const entry = (NAMES[pname] || pname) + '=' + (NAMES[param] || param)
        if (!window.__f.params.includes(entry)) window.__f.params.push(entry)
      }
      return nTP(target, pname, param)
    }
    const nGM = gl.generateMipmap.bind(gl)
    gl.generateMipmap = function (...a) {
      if (bound && tiles.has(bound)) window.__f.mipmaps++
      return nGM(...a)
    }
    return gl
  }
})()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(12000)
const ev = (js) => cdp.evaluate(js)
console.log('tile textures uploaded :', await ev("window.__f.tileTex"))
console.log('filters wplace sets    :', await ev("window.__f.params.join(' | ') || '(none seen)'"))
console.log('generateMipmap calls   :', await ev("window.__f.mipmaps"))
cdp.close(); await closeTab(tab.id)
