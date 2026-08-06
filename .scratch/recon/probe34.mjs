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
await sleep(13_000)
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(name, Buffer.from(data, 'base64'))
}
// Where did our button land relative to theirs?
console.log(await cdp.evaluate(`(() => {
  const rail = document.querySelector('.flex.flex-col.items-center.gap-3')
  return [...rail.querySelectorAll('button')].map(b => (b.title||'?') + ' @' + Math.round(b.getBoundingClientRect().top)).join(' | ')
})()`))
await cdp.evaluate(`document.getElementById('wts-rail-button').click()`)
await sleep(600)
await shot('/tmp/wts-panel-tree.png')
await cdp.evaluate(`document.querySelector('#wts-panel button[aria-label="Settings"]').click()`)
await sleep(500)
await shot('/tmp/wts-panel-settings.png')
cdp.close(); await closeTab(tab.id)
