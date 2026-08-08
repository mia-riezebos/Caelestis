import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const SERVER = "https://epic-recognised-raises-cube.trycloudflare.com", TOKEN = "SMRRRT591GCFQGQBKJP5974YDY"
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.removeItem('caelestis.state.v1')}catch{}" })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}' })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
for (let i = 0; i < 24; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(1200)
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }
const realClick = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
await ev("document.getElementById('wts-rail-button').click()")
await sleep(400)
await ev("document.querySelector('#wts-panel [data-wts-settings]').click()")
await sleep(400)
await ev("(() => { const i = document.querySelector('#wts-panel input[type=url]'); i.value = " + JSON.stringify(SERVER) + "; i.dispatchEvent(new Event('input',{bubbles:true})) })()")
await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Add').click()")
await sleep(3000)
await ev("(() => { const i = document.querySelector('#wts-panel input[type=password]'); i.value = " + JSON.stringify(TOKEN) + "; i.dispatchEvent(new Event('input',{bubbles:true})) })()")
await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Connect').click()")
await sleep(3500)
await ev("document.querySelector('#wts-panel [data-wts-back]').click()")
await sleep(2500)

const nodeRow = "[...document.querySelectorAll('#wts-panel .wts-row')].find(r=>r.dataset.wtsKey.startsWith('node:'))"
const box = JSON.parse(await ev("(() => { const r = " + nodeRow + ".getBoundingClientRect(); return JSON.stringify([r.left+60, r.top+14]) })()"))
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box[0], y: box[1], button: 'right', buttons: 2, clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box[0], y: box[1], button: 'right', buttons: 0, clickCount: 1 })
await sleep(500)
console.log('menu open      :', await ev("!!document.querySelector('[data-wts-menu]')"))

const item = await ev("(() => { const b=[...document.querySelectorAll('[data-wts-menu] button')].find(x=>x.textContent.trim()==='Rename'); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()")
if (item === null) { console.log('Rename item not found'); } else {
  const [ix, iy] = JSON.parse(item)
  await realClick(ix, iy)
  await sleep(800)
  console.log('menu after click:', await ev("!!document.querySelector('[data-wts-menu]')"))
  console.log('rename input   :', await ev("document.querySelector('#wts-panel input[type=text]')?.value ?? '(none)'"))
}
// Every other item must work too — the bug was never rename-specific.
for (const label of ['New folder', 'Import template']) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box[0], y: box[1], button: 'right', buttons: 2, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box[0], y: box[1], button: 'right', buttons: 0, clickCount: 1 })
  await sleep(400)
  const at = await ev("(() => { const b=[...document.querySelectorAll('[data-wts-menu] button')].find(x=>x.textContent.trim()===" + JSON.stringify(label) + "); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()")
  if (at === null) { console.log(label, ': item missing'); continue }
  const [ax, ay] = JSON.parse(at)
  await realClick(ax, ay)
  await sleep(2000)
  const effect = await ev("(document.querySelector('#wts-panel [data-wts-toast]')?.textContent) || (document.querySelector('#wts-panel input[type=text]') ? 'rename started' : '(nothing)')")
  console.log(label.padEnd(16), ':', effect)
  await ev("document.querySelector('#wts-panel input[type=text]') && document.querySelector('#wts-panel input[type=text]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await sleep(400)
}
await shot('/tmp/wts-ctx-rename.png')
cdp.close(); await closeTab(tab.id)
