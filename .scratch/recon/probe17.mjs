import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 900, height: 700, deviceScaleFactor: 2, mobile: true,
})
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

// A north-up map has zero off-diagonal terms in the projection matrix. Rotation makes m[1]/m[4]
// non-zero, which is what an axis-aligned quad cannot represent.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__rot = { max: 0, samples: 0, dpr: window.devicePixelRatio }
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const names = new Map()
    const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) names.set(l, n); return l }
    const nUM = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (loc, tr, v, ...rest) {
      if (names.get(loc) === 'u_projection_matrix') {
        const scale = Math.max(Math.abs(v[0]), Math.abs(v[5])) || 1
        const skew = Math.max(Math.abs(v[1]), Math.abs(v[4])) / scale
        if (skew > window.__rot.max) window.__rot.max = skew
        window.__rot.samples++
      }
      return nUM(loc, tr, v, ...rest)
    }
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
const baseline = await cdp.evaluate('({...window.__rot})')

// Two-finger twist: the gesture that would rotate, if wplace allowed it.
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
const cx = 450, cy = 350, r = 140
const at = (angleDeg) => {
  const a = (angleDeg * Math.PI) / 180
  return [
    { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), id: 1 },
    { x: cx - r * Math.cos(a), y: cy - r * Math.sin(a), id: 2 },
  ]
}
await touch('touchStart', at(0))
for (let deg = 10; deg <= 90; deg += 10) { await touch('touchMove', at(deg)); await sleep(80) }
await touch('touchEnd', [])
await sleep(2_500)
const after = await cdp.evaluate('({...window.__rot})')
console.log(JSON.stringify({ baseline, after,
  rotationDetected: after.max > 1e-6,
  maxSkewRatio: after.max }, null, 2))
cdp.close(); await closeTab(tab.id)
