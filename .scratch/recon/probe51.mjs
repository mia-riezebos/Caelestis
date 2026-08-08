import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
// Track the projection matrix so we can tell whether the camera actually moved.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  window.__m = { last: null }
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
    gl.uniformMatrix4fv = function (l, tr, v, ...rest) {
      if (names.get(l) === 'u_projection_matrix') window.__m.last = Array.from(v).slice(0,16).join(',')
      return nUM(l, tr, v, ...rest)
    }
    return gl
  }
})()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
await sleep(11000)
const before = await cdp.evaluate("window.__m.last")

// Synthetic PointerEvents dispatched from page script, exactly as a userscript would.
await cdp.evaluate(`(async () => {
  const c = document.querySelector('canvas.maplibregl-canvas').parentElement
  const common = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  c.dispatchEvent(new PointerEvent('pointerdown', { ...common, clientX: 700, clientY: 400, button: 0, buttons: 1 }))
  for (let i = 1; i <= 6; i++) {
    c.dispatchEvent(new PointerEvent('pointermove', { ...common, clientX: 700 - i*40, clientY: 400, buttons: 1 }))
    await new Promise(r => requestAnimationFrame(r))
  }
  c.dispatchEvent(new PointerEvent('pointerup', { ...common, clientX: 460, clientY: 400, button: 0, buttons: 0 }))
})()`)
await sleep(2000)
console.log('synthetic drag moved the map? ', (await cdp.evaluate("window.__m.last")) !== before)

// Synthetic wheel.
const beforeWheel = await cdp.evaluate("window.__m.last")
await cdp.evaluate("document.querySelector('canvas.maplibregl-canvas').parentElement.dispatchEvent(new WheelEvent('wheel',{clientX:600,clientY:400,deltaY:-120,bubbles:true,cancelable:true}))")
await sleep(2000)
console.log('synthetic wheel moved the map?', (await cdp.evaluate("window.__m.last")) !== beforeWheel)

// Real CDP input, for comparison.
const beforeReal = await cdp.evaluate("window.__m.last")
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700 - i*40, y: 400, button: 'left', buttons: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 460, y: 400, button: 'left', buttons: 0 })
await sleep(2000)
console.log('real input moved the map?     ', (await cdp.evaluate("window.__m.last")) !== beforeReal)
cdp.close(); await closeTab(tab.id)
