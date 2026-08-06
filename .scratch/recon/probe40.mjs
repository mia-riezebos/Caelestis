import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Security.enable')
// wrangler's local TLS cert is self-signed, so a real browser would refuse it. Only the dev
// harness ignores that; a deployed server has a real certificate.
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true })
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.removeItem('caelestis.state.v1')}catch{}` })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
for (let i = 0; i < 24; i++) { if (await cdp.evaluate(`!!document.getElementById('wts-rail-button')`)) break; await sleep(500) }
await sleep(1200)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }

await cdp.evaluate(`document.getElementById('wts-rail-button').click()`)
await sleep(500)
await shot('/tmp/wts-tree-local.png')
console.log('tree:', await cdp.evaluate(`document.querySelector('#wts-panel [data-wts-body]').innerText.replace(/\\n+/g,' | ')`))

// Connect to the miniflare server running on 8787.
await cdp.evaluate(`document.querySelector('#wts-panel [data-wts-settings]').click()`)
await sleep(400)
await cdp.evaluate(`(() => {
  const i = document.querySelector('#wts-panel input[type=url]')
  i.value = 'https://epic-recognised-raises-cube.trycloudflare.com'
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await cdp.evaluate(`[...document.querySelectorAll('#wts-panel button')].find(b => b.textContent.trim()==='Add').click()`)
await sleep(2500)
console.log('after add:', await cdp.evaluate(`document.querySelector('#wts-panel p.text-xs.px-3.pb-2')?.innerText ?? '(no status)'`))
await shot('/tmp/wts-connect.png')
await cdp.evaluate(`document.querySelector('#wts-panel [data-wts-back]').click()`)
await sleep(500)
console.log('tree now:', await cdp.evaluate(`document.querySelector('#wts-panel [data-wts-body]').innerText.replace(/\\n+/g,' | ')`))
await shot('/tmp/wts-tree-connected.png')
cdp.close(); await closeTab(tab.id)
