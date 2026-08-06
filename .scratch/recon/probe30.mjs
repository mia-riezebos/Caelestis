import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__u = { phase: 'zoom11', zoom11: {}, zoomedOut: {} }
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const names = new Map()
    let tex = null
    const tiles = new WeakSet()
    const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) names.set(l, n); return l }
    const nBT = gl.bindTexture.bind(gl); gl.bindTexture = (a, b) => { tex = b; return nBT(a, b) }
    const nTI = gl.texImage2D.bind(gl)
    gl.texImage2D = function (...a) { const s = a[a.length-1]
      if (tex && s instanceof ImageBitmap && s.width === 1000) tiles.add(tex); return nTI(...a) }
    // Record every scalar uniform, keyed by name, so a fade shows up as a value not a guess.
    const scalars = {}
    const n1f = gl.uniform1f.bind(gl)
    gl.uniform1f = function (loc, v) {
      const n = names.get(loc)
      if (n) scalars[n] = v
      return n1f(loc, v)
    }
    const nDE = gl.drawElements.bind(gl)
    gl.drawElements = function (...a) {
      if (tex && tiles.has(tex)) {
        const bucket = window.__u[window.__u.phase]
        for (const [k, v] of Object.entries(scalars)) {
          bucket[k] = bucket[k] ?? { min: v, max: v }
          bucket[k].min = Math.min(bucket[k].min, v)
          bucket[k].max = Math.max(bucket[k].max, v)
        }
        bucket.__tileDraws = (bucket.__tileDraws ?? 0) + 1
      }
      return nDE(...a)
    }
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
const brief = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => /opacity|fade|__tileDraws/i.test(k))
  .map(([k, v]) => [k, typeof v === 'object' ? `${v.min}..${v.max}` : v]))
console.log('at zoom 11   :', JSON.stringify(brief(await cdp.evaluate('window.__u.zoom11'))))

await cdp.evaluate(`window.__u.phase='zoomedOut'`)
await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='-'); window.__minus=b })()`)
for (let i = 0; i < 3; i++) { await cdp.evaluate('window.__minus && window.__minus.click()'); await sleep(400) }
await sleep(3000)
await cdp.evaluate(`window.__u.settled = {}; window.__u.phase='settled'`)
await sleep(3000)
console.log('during zoom :', JSON.stringify(brief(await cdp.evaluate('window.__u.zoomedOut'))))
console.log('settled out :', JSON.stringify(brief(await cdp.evaluate('window.__u.settled'))))
console.log('all settled uniforms:', JSON.stringify(await cdp.evaluate('window.__u.settled')).slice(0, 600))
cdp.close(); await closeTab(tab.id)
