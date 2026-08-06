import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(6000)
const ev = (js) => cdp.evaluate(js)
console.log('templates      :', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>t.name))"))
console.log('Object.prototype clean:', await ev("!Object.getOwnPropertyDescriptor(Object.prototype,'_canvasContainer') && !Object.getOwnPropertyDescriptor(Object.prototype,'_canvas')"))
const url0 = await ev("location.href")
const centre0 = await ev("JSON.stringify(window.__map?.getCenter?.() ?? 'no map exposed')")

await ev("document.getElementById('wts-rail-button').click()")
await sleep(1200)
const clicked = await ev("(() => { const b=[...document.querySelectorAll('#wts-panel .wts-row')].find(r=>r.dataset.wtsKey.startsWith('local:'))?.querySelector('button[aria-label=\"Go to\"]'); if(!b) return false; b.click(); return true })()")
console.log('go-to clicked  :', clicked)
await sleep(6000)
console.log('page reloaded  :', (await ev("location.href")) !== url0 ? 'YES (fallback)' : 'no — flew in-game')
console.log('centre before  :', centre0)
console.log('centre after   :', await ev("JSON.stringify(window.__map?.getCenter?.() ?? 'n/a')"))
console.log('zoom after     :', await ev("window.__map?.getZoom?.() ?? 'n/a'"))
console.log('template origin:', await ev("JSON.stringify((window.__wtsLocal??[]).map(t=>[t.originX,t.originY,t.width,t.height]))"))
console.log('tiles on screen:', await ev("(window.__wtsFrame ?? 'n/a')"))
console.log('overlay ink    :', await ev(`(() => {
  const c = document.querySelector('canvas[data-wts-overlay]'); if (!c) return 'none'
  const s = document.createElement('canvas'); s.width=60; s.height=40
  const x = s.getContext('2d'); x.drawImage(c,0,0,60,40)
  const d = x.getImageData(0,0,60,40).data; let n=0
  for (let i=3;i<d.length;i+=4) if (d[i]>8) n++
  return n + ' / 2400 painted'
})()`))
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
;(await import('node:fs')).writeFileSync('/tmp/wts-flew.png', Buffer.from(data, 'base64'))
cdp.close(); await closeTab(tab.id)
