import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
for (let i = 0; i < 24; i++) { if (await cdp.evaluate(`!!document.getElementById('wts-rail-button')`)) break; await sleep(500) }
await sleep(1500)
await cdp.evaluate(`document.getElementById('wts-rail-button').click()`)
await sleep(500)
// Open the sort dropdown the way a person does: focus the trigger.
await cdp.evaluate(`document.querySelector('#wts-panel .dropdown button').focus()`)
await sleep(500)
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/wts-sort.png', Buffer.from(data, 'base64'))
console.log(await cdp.evaluate(`(() => {
  const d = document.querySelector('#wts-panel .dropdown')
  const m = d.querySelector('.dropdown-content')
  const r = m.getBoundingClientRect()
  const t = d.querySelector('button').getBoundingClientRect()
  return 'trigger ' + [t.left,t.top,t.width,t.height].map(Math.round).join(',')
    + ' | menu ' + [r.left,r.top,r.width,r.height].map(Math.round).join(',')
    + ' | items: ' + [...m.querySelectorAll('li button')].map(b => b.textContent.trim()).join(' / ')
})()`))
cdp.close(); await closeTab(tab.id)
