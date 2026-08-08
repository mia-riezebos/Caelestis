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
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-78.8676&lng=-122.7202&zoom=11.4' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
for (let i = 0; i < 30; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(8000)
console.log('frame:', await ev("window.__wtsFrame ?? 'n/a'"))

// Look for a hairline seam: scan for columns of near-transparent pixels flanked by opaque ones.
console.log('seam scan:', await ev(`(() => {
  const c = document.querySelector('canvas[data-wts-overlay]')
  if (!c) return 'no overlay'
  const g = c.getContext('2d')
  const h = Math.min(400, c.height)
  const d = g.getImageData(0, Math.floor(c.height/2) - h/2, c.width, h).data
  let seamCols = 0
  for (let x = 1; x < c.width - 1; x++) {
    let gapRows = 0, leftRows = 0, rightRows = 0
    for (let y = 0; y < h; y += 4) {
      const at = (xx) => d[(y * c.width + xx) * 4 + 3]
      if (at(x) < 16 && at(x - 1) > 200 && at(x + 1) > 200) gapRows++
      if (at(x - 1) > 200) leftRows++
      if (at(x + 1) > 200) rightRows++
    }
    if (gapRows > h / 8 && leftRows > h / 8 && rightRows > h / 8) seamCols++
  }
  return seamCols + ' transparent seam columns found'
})()`))
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/wts-seam.png', Buffer.from(data, 'base64'))
cdp.close(); await closeTab(tab.id)
