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
await sleep(600)

const serverRow = "[...document.querySelectorAll('#wts-panel .wts-row')].find(r=>r.dataset.wtsKey.startsWith('server:'))"
console.log('actions on server:', await ev(serverRow + ".querySelectorAll('.wts-actions button').length"))
console.log('actions on local :', await ev("[...document.querySelectorAll('#wts-panel .wts-row')].find(r=>r.dataset.wtsKey==='local').querySelectorAll('.wts-actions button').length"))

// Right-click the server row.
const box = JSON.parse(await ev("(() => { const r = " + serverRow + ".getBoundingClientRect(); return JSON.stringify([r.left+40, r.top+12]) })()"))
await ev(serverRow + ".dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: " + box[0] + ", clientY: " + box[1] + " }))")
await sleep(400)
console.log('context menu     :', await ev("[...document.querySelectorAll('[data-wts-menu] button')].map(b=>b.textContent.trim()).join(' | ') || '(none)'"))
await shot('/tmp/wts-context-menu.png')

// New folder from the menu: no prompt, auto-named, straight into rename.
await ev("[...document.querySelectorAll('[data-wts-menu] button')].find(b=>b.textContent.trim()==='New folder').click()")
await sleep(3500)
console.log('rows now         :', await ev("[...document.querySelectorAll('#wts-panel .wts-row')].map(r=>r.dataset.wtsKey).join(' | ')"))
console.log('node fetch       :', await ev("document.querySelector('#wts-panel [data-wts-toast]')?.textContent ?? '(no toast)'"))
console.log('rename input     :', await ev("document.querySelector('#wts-panel input[type=text]')?.value ?? '(none)'"))
await shot('/tmp/wts-rename.png')
// Type a new name and press Enter; the change must reach the server.
await ev("(() => { const i = document.querySelector('#wts-panel input[type=text]'); i.value = 'Renamed Inline'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})) })()")
await sleep(3000)
console.log('after enter      :', await ev("[...document.querySelectorAll('#wts-panel .wts-name')].map(n=>n.textContent).join(' | ')"))
console.log('still editing?   :', await ev("!!document.querySelector('#wts-panel input[type=text]')"))
await shot('/tmp/wts-renamed.png')
cdp.close(); await closeTab(tab.id)
