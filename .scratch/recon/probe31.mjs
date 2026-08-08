import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wtsDebug','1')}catch{}` })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(11_000)
await cdp.evaluate('window.__wts.clear()')
await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='-'); window.__minus=b })()`)
for (let i = 0; i < 3; i++) { await cdp.evaluate('window.__minus && window.__minus.click()'); await sleep(350) }
await sleep(3000)
const out = await cdp.evaluate(`(() => {
  const ev = window.__wts.events()
  const withTiles = ev.filter(e => e.category === 'frame' && e.data && e.data.quads > 0)
  const cleared = ev.filter(e => e.category === 'clear' && e.message.includes('clearing now'))
  const last = withTiles[withTiles.length - 1]
  const first = cleared[0]
  const c = window.__wts.counters()
  return {
    lastFrameWithTiles: last ? last.at : null,
    clearedAt: first ? first.at : null,
    delayMs: last && first ? first.at - last.at : null,
    clearsTotal: cleared.length,
    noOpFrames: c['clear:already-empty'] ?? 0,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
