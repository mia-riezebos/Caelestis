import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const SERVER = "https://epic-recognised-raises-cube.trycloudflare.com", TOKEN = "SMRRRT591GCFQGQBKJP5974YDY"
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

console.log('kind icons     :', await ev("[...document.querySelectorAll('#wts-panel .wts-row')].map(r=>r.querySelectorAll('svg')[1].querySelector('path').getAttribute('d').slice(30,44)).join(' | ')"))
console.log('badges left    :', await ev("document.querySelectorAll('#wts-panel [data-wts-body] .badge').length"))
console.log('row cursor     :', await ev("getComputedStyle(document.querySelector('#wts-panel .wts-row')).cursor"))
console.log('gap            :', await ev("getComputedStyle(document.querySelector('#wts-panel [role=tree]')).gap"))
console.log('panel width    :', await ev("Math.round(document.getElementById('wts-panel').getBoundingClientRect().width)"))

// Resize by dragging the handle 120px left.
const hb = await ev("(() => { const r = document.querySelector('.wts-resize').getBoundingClientRect(); return JSON.stringify([r.left, r.width, r.height]) })()")
console.log('handle box     :', hb)
const h = JSON.parse(await ev("(() => { const r = document.querySelector('.wts-resize').getBoundingClientRect(); return JSON.stringify([r.left + r.width/2, r.top + 200]) })()"))
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h[0], y: h[1], button: 'left', buttons: 1, clickCount: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h[0] - 120, y: h[1], button: 'left', buttons: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h[0] - 120, y: h[1], button: 'left', buttons: 0 })
await sleep(500)
console.log('after resize   :', await ev("Math.round(document.getElementById('wts-panel').getBoundingClientRect().width)"))
console.log('persisted width:', await ev("JSON.parse(localStorage.getItem('caelestis.state.v1')).panelWidth"))

// Create a folder on the server, answering the prompt.
await ev("window.prompt = () => 'Folder 8821'")
await ev("(() => { const rows=[...document.querySelectorAll('#wts-panel .wts-row')]; const r=rows.find(x=>x.dataset.wtsKey.startsWith('server:')); r.querySelector('button[aria-label=\"New folder\"]').click() })()")
await sleep(2500)
console.log('create folder  :', await ev("document.querySelector('#wts-panel [data-wts-toast]')?.textContent ?? '(no toast)'"))
await shot('/tmp/wts-tree-final.png')
cdp.close(); await closeTab(tab.id)
