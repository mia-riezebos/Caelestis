import { Session, closeTab, newTab, sleep } from './cdp.mjs'
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
      if (names.get(l) === 'u_projection_matrix') {
        const s = Array.from(v).slice(0,16).join(',')
        if (s !== window.__m.last) { window.__m.last = s; window.__m.changes++ }
      }
      return nUM(l, tr, v, ...rest) }
    return gl } })()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
await sleep(11000)

const searchBtns = await cdp.evaluate("[...document.querySelectorAll('button')].filter(b=>(b.title||'').trim()==='Search').length")
console.log('buttons titled Search:', searchBtns)
// Click it as a person does, with real input, in case a synthetic click is ignored here too.
const at = JSON.parse(await cdp.evaluate("(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').trim()==='Search'); const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()"))
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 })
await sleep(2000)
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
;(await import('node:fs')).writeFileSync('/tmp/wts-search-modal.png', Buffer.from(data, 'base64'))
// Find it by what it is, not by where it sits: the only button actually rendered and titled Random.
console.log('random exists:', await cdp.evaluate("[...document.querySelectorAll('button')].filter(b=>/random/i.test(b.title||b.getAttribute('aria-label')||'')).map(b=>(b.title||b.getAttribute('aria-label'))+' visible='+b.checkVisibility()).join(' | ') || '(none)'"))
console.log('search field :', await cdp.evaluate("[...document.querySelectorAll('input')].filter(i=>i.checkVisibility()).map(i=>`${i.type}:${i.placeholder||''}`).join(' | ')"))

// Click "Random place" and see whether the camera moves without a reload.
const url0 = await cdp.evaluate("location.href")
await cdp.evaluate("window.__m.changes = 0")
const clicked = await cdp.evaluate("(() => { const b=[...document.querySelectorAll('button')].find(x=>/random/i.test(x.title||x.getAttribute('aria-label')||'') && x.checkVisibility()); if(!b) return false; b.click(); return true })()")
console.log('random clicked:', clicked)
await sleep(5000)
console.log('matrix changes:', await cdp.evaluate("window.__m.changes"))
console.log('url changed   :', (await cdp.evaluate("location.href")) !== url0, '->', await cdp.evaluate("location.href"))
cdp.close(); await closeTab(tab.id)
