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
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }
const setField = (sel, val) => cdp.evaluate("(() => { const i = document.querySelector(" + JSON.stringify(sel) + "); i.value = " + JSON.stringify(val) + "; i.dispatchEvent(new Event('input',{bubbles:true})) })()")
const clickText = (t) => cdp.evaluate("[...document.querySelectorAll('#wts-panel button')].find(b => b.textContent.trim()===" + JSON.stringify(t) + ").click()")

await cdp.evaluate("document.getElementById('wts-rail-button').click()")
await sleep(400)
await cdp.evaluate("document.querySelector('#wts-panel [data-wts-settings]').click()")
await sleep(400)
await setField('#wts-panel input[type=url]', SERVER)
await clickText('Add')
await sleep(3000)
await setField('#wts-panel input[type=password]', TOKEN)
await clickText('Connect')
await sleep(3000)
await cdp.evaluate("document.querySelector('#wts-panel [data-wts-back]').click()")
await sleep(600)
console.log('checkboxes all on?', await cdp.evaluate("[...document.querySelectorAll('#wts-panel [data-wts-body] input[type=checkbox]')].map(c=>c.checked).join(',')"))
console.log('caret rotations  :', await cdp.evaluate("[...document.querySelectorAll('#wts-panel [data-wts-body] svg')].map(s=>s.style.transform||'-').join(' ')"))
await shot('/tmp/wts-tree-expanded.png')
// Collapse Local and confirm the caret turns and children vanish.
await cdp.evaluate("document.querySelectorAll('#wts-panel [data-wts-body] button[aria-expanded]')[0].click()")
await sleep(500)
console.log('after collapse   :', await cdp.evaluate("document.querySelectorAll('#wts-panel [data-wts-body] button[aria-expanded]')[0].getAttribute('aria-expanded') + ' rot=' + document.querySelector('#wts-panel [data-wts-body] svg').style.transform"))
await shot('/tmp/wts-tree-collapsed.png')
cdp.close(); await closeTab(tab.id)
