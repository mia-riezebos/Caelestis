import { writeFileSync } from 'node:fs'
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
      if (names.get(l) === 'u_projection_matrix') { const s = Array.from(v).slice(0,16).join(',')
        if (s !== window.__m.last) { window.__m.last = s; window.__m.changes++ } }
      return nUM(l, tr, v, ...rest) }
    return gl } })()` })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(12000)
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }

// Real click on the Search rail button, since synthetic gestures are unreliable here.
const at = JSON.parse(await ev("(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').trim()==='Search'); const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()"))
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 })
await sleep(2500)
await shot('/tmp/wts-search.png')
console.log('visible dialogs:', await ev("[...document.querySelectorAll('dialog, .modal, .modal-box')].filter(e=>e.checkVisibility()).map(e=>e.className.slice(0,40)).join(' | ') || '(none)'"))
console.log('random button  :', await ev("[...document.querySelectorAll('button')].filter(b=>/random/i.test(b.title||b.getAttribute('aria-label')||'')).map(b=>(b.title||b.getAttribute('aria-label'))+' vis='+b.checkVisibility()).join(' | ') || '(none)'"))
console.log('visible inputs :', await ev("[...document.querySelectorAll('input')].filter(i=>i.checkVisibility()).map(i=>`${i.type}:${i.placeholder||''}`).join(' | ') || '(none)'"))

// If the dice is there, does clicking it move the camera without a reload?
const dice = await ev("(() => { const b=[...document.querySelectorAll('button')].find(x=>/random/i.test(x.title||x.getAttribute('aria-label')||'') && x.checkVisibility()); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()")
if (dice) {
  const url0 = await ev("location.href")
  await ev("window.__m.changes = 0")
  const [dx, dy] = JSON.parse(dice)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dx, y: dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(5000)
  console.log('camera moved   :', (await ev("window.__m.changes")) > 0)
  console.log('page reloaded  :', (await ev("location.href")) !== url0, '->', (await ev("location.href")).slice(0, 70))
} else console.log('no visible random button to click')
cdp.close(); await closeTab(tab.id)
