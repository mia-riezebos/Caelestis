import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const run = async (zoom) => {
  const tab = await newTab('about:blank')
  const cdp = await Session.attach(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  window.__q = { widths: [], skews: [] }
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const canvas = this
    const names = new Map(); let proj = null; let tex = null
    const tiles = new WeakSet()
    const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) names.set(l, n); return l }
    const nUM = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (l, tr, v, ...rest) {
      if (names.get(l) === 'u_projection_matrix') proj = v
      return nUM(l, tr, v, ...rest)
    }
    const nBT = gl.bindTexture.bind(gl)
    gl.bindTexture = (tg, tx) => { tex = tx; return nBT(tg, tx) }
    const nTI = gl.texImage2D.bind(gl)
    gl.texImage2D = function (...a) {
      const s = a[a.length - 1]
      if (tex && s instanceof ImageBitmap && s.width === 1000) tiles.add(tex)
      return nTI(...a)
    }
    const rec = () => {
      if (!tex || !proj || !tiles.has(tex)) return
      const P = (x, y) => { const cx = proj[0]*x+proj[4]*y+proj[12], cw = proj[3]*x+proj[7]*y+proj[15]
        const cy = proj[1]*x+proj[5]*y+proj[13]; return [cx/cw, cy/cw] }
      const [x0] = P(0,0), [x1] = P(8192,8192)
      const w = ((x1*0.5+0.5) - (x0*0.5+0.5)) * canvas.width
      const scale = Math.max(Math.abs(proj[0]), Math.abs(proj[5])) || 1
      const skew = Math.max(Math.abs(proj[1]), Math.abs(proj[4])) / scale
      if (window.__q.widths.length < 200) { window.__q.widths.push(w); window.__q.skews.push(skew) }
    }
    for (const n of ['drawArrays','drawElements']) { const f = gl[n].bind(gl); gl[n] = (...a) => { rec(); return f(...a) } }
    return gl
  }
})()` })
  await cdp.send('Page.navigate', { url: `https://wplace.live/?lat=52.429222&lng=5.009766&zoom=${zoom}` })
  await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
  await sleep(9_000)
  const q = await cdp.evaluate(`(() => { const w = window.__q.widths
    return { n: w.length, min: Math.min(...w), max: Math.max(...w), maxSkew: Math.max(...window.__q.skews, 0) } })()`)
  cdp.close(); await closeTab(tab.id)
  return q
}
for (const z of [11, 14, 17, 19, 20, 21]) {
  const q = await run(z)
  const over = q.max > 1e5
  console.log(`zoom ${String(z).padEnd(3)} tileWidth ${q.n ? Math.round(q.max).toLocaleString().padStart(12) : '        none'} px   exceeds 1e5 bound: ${over}`)
}
