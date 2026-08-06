import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const grab = async (url) => {
  const tab = await newTab('about:blank')
  const cdp = await Session.attach(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  window.__gl = { matrices: [] }
  const native = HTMLCanvasElement.prototype.getContext
  let done = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const ctx = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !ctx || done) return ctx
    done = true
    const nm = ctx.uniformMatrix4fv.bind(ctx)
    ctx.uniformMatrix4fv = function (l, tr, v, ...rest) {
      if (window.__gl.matrices.length < 400) window.__gl.matrices.push(Array.from(v).slice(0, 16))
      return nm(l, tr, v, ...rest)
    }
    return ctx
  }
})()` })
  await cdp.send('Page.navigate', { url })
  await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
  await sleep(10_000)
  const m = await cdp.evaluate('({ count: window.__gl.matrices.length, distinct: new Set(window.__gl.matrices.map(a=>a.join(","))).size, first: window.__gl.matrices[0], last: window.__gl.matrices[window.__gl.matrices.length-1] })')
  cdp.close(); await closeTab(tab.id)
  return m
}
const a = await grab('https://wplace.live/?lat=52.37&lng=4.90&zoom=11')
const b = await grab('https://wplace.live/?lat=52.37&lng=4.90&zoom=14')
const c = await grab('https://wplace.live/?lat=48.85&lng=2.35&zoom=11')
const brief = (m) => ({ count: m.count, distinct: m.distinct, first4: m.first && m.first.slice(0,4).map(n=>+n.toPrecision(6)) })
console.log('zoom 11 Amsterdam:', JSON.stringify(brief(a)))
console.log('zoom 14 Amsterdam:', JSON.stringify(brief(b)))
console.log('zoom 11 Paris    :', JSON.stringify(brief(c)))
console.log('zoom differs :', JSON.stringify(a.first) !== JSON.stringify(b.first))
console.log('place differs:', JSON.stringify(a.first) !== JSON.stringify(c.first))
