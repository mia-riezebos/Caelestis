import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__gl = { wrapped: false, matrices: 0, draws: 0, lastMatrix: null, programs: 0 }
  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = nativeGetContext.call(this, type, ...rest)
    if (!String(type).startsWith('webgl') || !ctx || window.__gl.wrapped) return ctx
    window.__gl.wrapped = true
    window.__glCtx = ctx

    // MapLibre uploads its MVP matrix per draw. That matrix *is* the transform, exactly, every
    // frame — no need for the Map object to place an overlay correctly.
    const nativeUniformMatrix4fv = ctx.uniformMatrix4fv.bind(ctx)
    ctx.uniformMatrix4fv = function (loc, transpose, value, ...r) {
      window.__gl.matrices++
      window.__gl.lastMatrix = Array.from(value).slice(0, 16)
      return nativeUniformMatrix4fv(loc, transpose, value, ...r)
    }
    for (const name of ['drawArrays', 'drawElements']) {
      const native = ctx[name].bind(ctx)
      ctx[name] = function (...args) { window.__gl.draws++; return native(...args) }
    }
    const nativeUseProgram = ctx.useProgram.bind(ctx)
    ctx.useProgram = function (p) { window.__gl.programs++; return nativeUseProgram(p) }
    return ctx
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
const a = await cdp.evaluate('({...window.__gl})')
// Pan with real input events. Synthetic MouseEvents do not drive MapLibre's pointer handlers, so
// a DOM-dispatched drag leaves the view untouched and proves nothing.
const mouse = (type, x, y, button = 'left') =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseMoved' ? 1 : 1, clickCount: 1 })
await mouse('mousePressed', 700, 450)
for (let i = 1; i <= 8; i++) await mouse('mouseMoved', 700 - i * 30, 450)
await mouse('mouseReleased', 460, 450)
await sleep(3_000)
const b = await cdp.evaluate('({...window.__gl})')
console.log(JSON.stringify({
  wrapped: a.wrapped, drawsAfterLoad: a.draws, matrixUploads: a.matrices, programSwitches: a.programs,
  matrixBefore: a.lastMatrix && a.lastMatrix.slice(0, 4).map(n => +n.toFixed(6)),
  matrixAfter: b.lastMatrix && b.lastMatrix.slice(0, 4).map(n => +n.toFixed(6)),
  matrixChanged: JSON.stringify(a.lastMatrix) !== JSON.stringify(b.lastMatrix),
  drawsGrew: b.draws > a.draws,
}, null, 2))
cdp.close(); await closeTab(tab.id)
