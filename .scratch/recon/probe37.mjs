import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)
// Wait for the rail rather than assuming it is ready — it is rendered by wplace's own app.
for (let i = 0; i < 20; i++) {
  const there = await cdp.evaluate(`!!document.getElementById('wts-rail-button')`)
  if (there) break
  await sleep(500)
}
const present = await cdp.evaluate(`(() => {
  const b = document.getElementById('wts-rail-button')
  const anchor = [...document.querySelectorAll('button')].find(x => (x.title||'').trim() === 'Overlays')
  return { ours: !!b, overlaysAnchor: !!anchor, buttons: document.querySelectorAll('button').length }
})()`)
console.log('presence:', JSON.stringify(present))
await cdp.evaluate(`document.getElementById('wts-rail-button').click()`)
await sleep(400)
await cdp.evaluate(`document.querySelector('#wts-panel [data-wts-settings]').click()`)
await sleep(400)
console.log(await cdp.evaluate(`(() => {
  const panel = document.getElementById('wts-panel')
  const p = panel.getBoundingClientRect()
  const rows = []
  for (const el of panel.querySelectorAll('h3, h2, .flex, input, select, button, p')) {
    const r = el.getBoundingClientRect()
    if (r.width < 10) continue
    const text = (el.textContent || el.placeholder || el.tagName).trim().slice(0, 22)
    rows.push(\`\${String(Math.round(r.left - p.left)).padStart(4)}  w\${String(Math.round(r.width)).padStart(4)}  h\${String(Math.round(r.height)).padStart(3)}  r\${getComputedStyle(el).borderRadius.split(' ')[0].padStart(6)}  \${el.tagName.toLowerCase()} "\${text}"\`)
  }
  return 'panel w=' + Math.round(p.width) + '\\n  dx    w     h   radius  el\\n' + rows.join('\\n')
})()`))
cdp.close(); await closeTab(tab.id)
