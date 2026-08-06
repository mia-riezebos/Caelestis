import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }
// Straight to the template, so it renders without needing a navigation.
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-78.8676&lng=-122.7202&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(8000)
console.log('templates    :', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>t.name))"))
console.log('frame        :', await ev("window.__wtsFrame ?? 'n/a'"))
console.log('mip levels   :', await ev("window.__wtsMips ?? 'n/a'"))
await shot('/tmp/wts-zoom11.png')
console.log('smoothing@11 :', await ev("(() => { const c=document.querySelector('canvas[data-wts-overlay]'); return c ? c.getContext('2d').imageSmoothingEnabled : 'n/a' })()"))
cdp.close(); await closeTab(tab.id)
