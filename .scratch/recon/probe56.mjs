import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => { window.__m = { last: null, changes: 0 }
  const native = HTMLCanvasElement.prototype.getContext; let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = native.call(this, t, ...r)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const names = new Map(); const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) names.set(l, n); return l }
    const nUM = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (l, tr, v, ...rest) {
      if (names.get(l) === 'u_projection_matrix') { const s2 = Array.from(v).slice(0,16).join(',')
        if (s2 !== window.__m.last) { window.__m.last = s2; window.__m.changes++ } }
      return nUM(l, tr, v, ...rest) }
    return gl } })()` })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(5000)
const ev = (js) => cdp.evaluate(js)
console.log('templates :', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>t.name))"))
const url0 = await ev("location.href")
// Drive the real navigation path the import uses.
const ok = await ev("(async () => { const m = await import('/x'); return false })().catch(() => null)")
// The module is bundled, so reach it through the panel's own Go-to action instead.
await ev("document.getElementById('wts-rail-button').click()")
await sleep(1200)
const clicked = await ev("(() => { const b=[...document.querySelectorAll('#wts-panel .wts-row')].find(r=>r.dataset.wtsKey.startsWith('local:'))?.querySelector('button[aria-label=\"Go to\"]'); if(!b) return false; b.click(); return true })()")
console.log('go-to clicked:', clicked)
await cdp.evaluate("window.__m.changes = 0")
await sleep(9000)
console.log('camera moved :', (await ev("window.__m.changes")) > 0, '(' + (await ev("window.__m.changes")) + ' matrix changes)')
console.log('dialog hidden:', await ev("!document.getElementById('wts-hide-search')"), '(style removed afterwards)')
console.log('url changed  :', (await ev("location.href")) !== url0)
console.log('url now      :', (await ev("location.href")).slice(0, 80))
console.log('reloaded?    :', await ev("performance.getEntriesByType('navigation')[0]?.type ?? '?'"))
cdp.close(); await closeTab(tab.id)
