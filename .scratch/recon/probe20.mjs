import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })

// For every flush, why were there no tiles? Distinguish "MapLibre drew no tile textures this
// frame" from "we deleted the attribution and no longer recognise them".
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const L = { flushes: [], deletes: 0, texUploads: 0, unattributedUploads: 0, subImage: 0 }
  window.__L = L
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const names = new Map(); let proj = null; let tex = null
    const tileOfTex = new WeakMap(); const known = new WeakSet()
    let draws = 0, tileDraws = 0, scheduled = false
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
      if (tex) {
        L.texUploads++
        if (s instanceof ImageBitmap && s.width === 1000) { tileOfTex.set(tex, 1); known.add(tex) }
        else if (known.has(tex)) { L.deletes++; L.unattributedUploads++;
          console.info('[probe] attribution deleted; source was ' + (s && s.constructor ? s.constructor.name : typeof s)) }
      }
      return nTI(...a)
    }
    const nTS = gl.texSubImage2D ? gl.texSubImage2D.bind(gl) : null
    if (nTS) gl.texSubImage2D = function (...a) { L.subImage++; return nTS(...a) }
    const rec = () => {
      draws++
      if (tex && tileOfTex.has(tex)) tileDraws++
      if (!scheduled) { scheduled = true
        queueMicrotask(() => { scheduled = false
          if (L.flushes.length < 120) L.flushes.push({ draws, tileDraws })
          draws = 0; tileDraws = 0 }) }
    }
    for (const n of ['drawArrays','drawElements']) { const f = gl[n].bind(gl); gl[n] = (...a) => { rec(); return f(...a) } }
    return gl
  }
})()
`,
})
const logs = []
cdp.on((m) => { if (m.method === 'Runtime.consoleAPICalled') {
  const t = m.params.args.map(a => a.value ?? '').join(' '); if (t.includes('[probe]')) logs.push(t) } })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(16_000)
const out = await cdp.evaluate(`(() => {
  const f = window.__L.flushes
  const empty = f.filter(x => x.tileDraws === 0)
  return {
    flushes: f.length,
    emptyFlushes: empty.length,
    emptyButBusy: empty.filter(x => x.draws > 5).length,
    emptyDrawCounts: [...new Set(empty.map(x => x.draws))].slice(0, 10),
    attributionDeletes: window.__L.deletes,
    texSubImage2DCalls: window.__L.subImage,
    sample: f.slice(0, 12),
  }
})()`)
console.log(JSON.stringify(out, null, 2))
console.log('delete reasons:', [...new Set(logs)].slice(0, 5))
cdp.close(); await closeTab(tab.id)
