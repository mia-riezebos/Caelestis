import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const FILE = join(homedir(), 'Downloads', 'cba.wplace')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
// Straight to where cba.wplace lives, so the template should be on screen once imported.
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-78.8676&lng=-122.7202&zoom=12' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(6000)
const ev = (js) => cdp.evaluate(js)
console.log('restored:', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>({n:t.name,w:t.width,h:t.height,tiles:t.tiles})))"))
const has = await ev("(window.__wtsLocal ?? []).some(t => t.width > 0)")
if (!has) {
  await ev("document.getElementById('wts-rail-button').click()")
  await sleep(600)
  await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Import a template')?.click()")
  await sleep(1200)
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  if (found.nodeId) await cdp.send('DOM.setFileInputFiles', { files: [FILE], nodeId: found.nodeId })
  for (let i = 0; i < 60; i++) {
    if (await ev("(window.__wtsLocal ?? []).some(t => t.width > 0)")) break
    await sleep(1000)
  }
}
await ev("document.getElementById('wts-panel') && document.getElementById('wts-rail-button').click()")
await sleep(3000)
console.log('overlay ink:', await ev(`(() => {
  const c = document.querySelector('canvas[data-wts-overlay]')
  if (!c) return 'no overlay canvas'
  const s = document.createElement('canvas'); s.width = 80; s.height = 50
  const x = s.getContext('2d'); x.drawImage(c, 0, 0, 80, 50)
  const d = x.getImageData(0,0,80,50).data
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
  return n + ' / 4000 sampled pixels painted'
})()`))
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/wts-template-on-map.png', Buffer.from(data, 'base64'))
cdp.close(); await closeTab(tab.id)
