import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-78.8676&lng=-122.7202&zoom=12' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await ev("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(9000)
console.log('templates      :', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>t.name))"))
console.log('overlay button :', await ev("!!document.querySelector('[id^=wts-overlay-button-]')"))
console.log('owned colours  :', await ev("(() => { try { return 'probed' } catch { return 'n/a' } })()"))

// Open the per-overlay menu and exercise a shape.
const opened = await ev("(() => { const b=document.querySelector('[id^=wts-overlay-button-]'); if(!b) return false; b.click(); return true })()")
await sleep(1200)
console.log('menu opened    :', opened && (await ev("!!document.getElementById('wts-overlay-menu')")))
console.log('menu sections  :', await ev("[...document.querySelectorAll('#wts-overlay-menu h4')].map(h=>h.textContent).join(' | ')"))
console.log('shape buttons  :', await ev("[...document.querySelectorAll('#wts-overlay-menu .join button')].map(b=>b.textContent).join(' | ')"))
console.log('swatches       :', await ev("document.querySelectorAll('#wts-overlay-menu .wts-swatch').length"))
// Clicking the map must NOT dismiss it.
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 500, button: 'left', buttons: 1, clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 500, button: 'left', buttons: 0, clickCount: 1 })
await sleep(800)
console.log('survives map click:', await ev("!!document.getElementById('wts-overlay-menu')"))
await ev("[...document.querySelectorAll('#wts-overlay-menu .join button')].find(b=>b.textContent==='Dot')?.click()")
await sleep(2500)
console.log('after Dot      :', await ev("window.__wtsFrame ?? 'n/a'"))
await shot('/tmp/wts-overlay-menu.png')
cdp.close(); await closeTab(tab.id)
