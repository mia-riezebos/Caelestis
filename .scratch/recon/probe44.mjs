import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const SERVER = "https://epic-recognised-raises-cube.trycloudflare.com", TOKEN = "P9FBWT3GESS4GKTYPFTASX621P"
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.removeItem('caelestis.state.v1')}catch{}" })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}' })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
for (let i = 0; i < 24; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(1200)
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }
const rows = () => ev("[...document.querySelectorAll('#wts-panel .wts-row')].map(r=>r.dataset.wtsKey).join(' | ')")

await ev("document.getElementById('wts-rail-button').click()")
await sleep(400)
await ev("document.querySelector('#wts-panel [data-wts-settings]').click()")
await sleep(400)
await ev("(() => { const i = document.querySelector('#wts-panel input[type=url]'); i.value = " + JSON.stringify(SERVER) + "; i.dispatchEvent(new Event('input',{bubbles:true})) })()")
await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Add').click()")
await sleep(3000)
await ev("(() => { const i = document.querySelector('#wts-panel input[type=password]'); i.value = " + JSON.stringify(TOKEN) + "; i.dispatchEvent(new Event('input',{bubbles:true})) })()")
await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Connect').click()")
await sleep(3000)
await ev("document.querySelector('#wts-panel [data-wts-back]').click()")
await sleep(600)

console.log('rows           :', await rows())
console.log('draggable      :', await ev("[...document.querySelectorAll('#wts-panel .wts-row')].map(r=>r.draggable).join(',')"))
console.log('checked        :', await ev("[...document.querySelectorAll('#wts-panel .wts-row input')].map(c=>c.checked).join(',')"))

// Hover the first row, then screenshot, so the card treatment is visible.
const b = JSON.parse(await ev("(() => { const r = document.querySelector('#wts-panel .wts-row').getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()"))
// CSS :hover needs the pointer to actually arrive; a single synthetic move is unreliable.
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b[0] - 40, y: b[1] - 20 })
await sleep(150)
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b[0], y: b[1] })
await sleep(400)
console.log('stylesheet     :', await ev("(document.getElementById('wts-styles')?.textContent || '').includes('.wts-row:hover')"))
console.log('hover bg       :', await ev("getComputedStyle(document.querySelector('#wts-panel .wts-row')).backgroundColor"))
await shot('/tmp/wts-tree-hover.png')

// Clicking the name toggles expansion; clicking the checkbox must not.
await ev("document.querySelector('#wts-panel .wts-row .wts-name').click()")
await sleep(300)
console.log('name click     :', await ev("document.querySelector('#wts-panel .wts-row').getAttribute('aria-expanded')"))
await ev("document.querySelector('#wts-panel .wts-row input').click()")
await sleep(300)
console.log('checkbox click :', await ev("document.querySelector('#wts-panel .wts-row').getAttribute('aria-expanded') + ' checked=' + document.querySelector('#wts-panel .wts-row input').checked"))

// Drag row 2 above row 1.
console.log('before drag    :', await rows())
await ev(`(() => {
  const rs = [...document.querySelectorAll('#wts-panel .wts-row')]
  const dt = new DataTransfer()
  rs[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  const box = rs[0].getBoundingClientRect()
  const o = { bubbles: true, dataTransfer: dt, clientY: box.top + 2 }
  rs[0].dispatchEvent(new DragEvent('dragover', o))
  rs[0].dispatchEvent(new DragEvent('drop', o))
})()`)
await sleep(500)
console.log('after drag     :', await rows())
console.log('persisted      :', await ev("(JSON.parse(localStorage.getItem('caelestis.state.v1')).customOrder||[]).join(' | ')"))
cdp.close(); await closeTab(tab.id)
