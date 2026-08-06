import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const SERVER = "https://epic-recognised-raises-cube.trycloudflare.com"
const TOKEN = "P9FBWT3GESS4GKTYPFTASX621P"
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
await sleep(600)
console.log('panel open? ', await cdp.evaluate("!!document.getElementById('wts-panel')"))
await cdp.evaluate("document.querySelector('#wts-panel [data-wts-settings]').click()")
await sleep(600)
console.log('view text  :', (await cdp.evaluate("document.querySelector('#wts-panel').innerText.replace(/\\n+/g,' | ')")).slice(0, 200))
console.log('inputs     :', await cdp.evaluate("[...document.querySelectorAll('#wts-panel input')].map(i=>i.type).join(',') || '(none)'"))
await setField('#wts-panel input[type=url]', SERVER)
await clickText('Add')
await sleep(3000)
console.log('1. after add   :', await cdp.evaluate("document.querySelector('#wts-panel .badge')?.textContent ?? '(none)'"))
await shot('/tmp/wts-auth-1-needscode.png')
console.log('   panel text  :', (await cdp.evaluate("document.querySelector('#wts-panel').innerText.replace(/\\n+/g,' | ')")).slice(0, 220))
console.log('   inputs      :', await cdp.evaluate("[...document.querySelectorAll('#wts-panel input')].map(i=>i.type).join(',')"))

await setField('#wts-panel input[type=password]', 'WRONGCODE')
await clickText('Connect')
await sleep(3000)
console.log('2. wrong code  :', await cdp.evaluate("[...document.querySelectorAll('#wts-panel p')].map(p=>p.innerText).find(t=>/accept|reach/i.test(t)) ?? '(none)'"))

await setField('#wts-panel input[type=password]', TOKEN)
await clickText('Connect')
await sleep(3000)
console.log('3. real code   :', await cdp.evaluate("document.querySelector('#wts-panel .badge')?.textContent ?? '(none)'"))
await shot('/tmp/wts-auth-2-connected.png')
console.log('4. panel radius:', await cdp.evaluate("getComputedStyle(document.getElementById('wts-panel')).borderRadius"))
cdp.close(); await closeTab(tab.id)
