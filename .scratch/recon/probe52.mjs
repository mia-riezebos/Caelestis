import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => { window.__m = { last: null }
  const native = HTMLCanvasElement.prototype.getContext; let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const names = new Map(); const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) names.set(l, n); return l }
    const nUM = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (l, tr, v, ...rest) {
      if (names.get(l) === 'u_projection_matrix') window.__m.last = Array.from(v).slice(0,16).join(',')
      return nUM(l, tr, v, ...rest) }
    return gl } })()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
await sleep(11000)

// (a) Does wplace react to history navigation without a reload?
let before = await cdp.evaluate("window.__m.last")
await cdp.evaluate(`(() => {
  history.pushState({}, '', '/?lat=48.85&lng=2.35&zoom=13')
  window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
})()`)
await sleep(3000)
console.log('popstate moved the map?  ', (await cdp.evaluate("window.__m.last")) !== before)

// (b) What does their Search accept? Open it and look at the field.
await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>(b.title||'').trim()==='Search').click()")
await sleep(1500)
console.log('search inputs :', await cdp.evaluate("[...document.querySelectorAll('input')].map(i=>`${i.type}:${i.placeholder||i.name||''}`).join(' | ')"))
before = await cdp.evaluate("window.__m.last")
// Try feeding it a coordinate pair the way a person would.
await cdp.evaluate(`(() => {
  const i = [...document.querySelectorAll('input')].find(x => /search|place|location/i.test(x.placeholder || ''))
  if (!i) return 'no field'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(i, '52.3702, 4.8952')
  i.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`).then(r => console.log('typed coords  :', r))
await sleep(3500)
console.log('results       :', await cdp.evaluate("[...document.querySelectorAll('[role=option], li button, .menu li')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,4).join(' | ') || '(none)'"))
cdp.close(); await closeTab(tab.id)
