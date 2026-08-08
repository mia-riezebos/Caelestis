import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wtsDebug','1')}catch{}` })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
const events = []
cdp.on((m) => { if (m.method === 'Runtime.consoleAPICalled') {
  const t = m.params.args.map(a => a.value ?? '').join(' ')
  if (t.includes('[wts:frame]') || t.includes('[wts:clear]')) events.push({ at: Date.now(), t }) } })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
const loadEnd = Date.now()

// Heavy interaction: pans, zoom in, zoom out — but never past the tile threshold.
const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
for (let r = 0; r < 3; r++) {
  await mouse('mousePressed', 900, 400)
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', 900 - i * 50, 400 + i * 10); await sleep(40) }
  await mouse('mouseReleased', 500, 480)
  for (let i = 0; i < 3; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -200 }); await sleep(150) }
  for (let i = 0; i < 3; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 200 }); await sleep(150) }
  await sleep(1500)
}
const mid = events.filter(e => e.at > loadEnd)
const armed = mid.filter(e => e.t.includes('arming'))
const cancelled = mid.filter(e => e.t.includes('cancelled'))
const fired = mid.filter(e => e.t.includes('grace elapsed'))

// How long does a real gap between tile-bearing frames get during interaction?
const tileFrames = mid.filter(e => /tileTextureDraws: [1-9]/.test(e.t)).map(e => e.at)
let maxGap = 0
for (let i = 1; i < tileFrames.length; i++) maxGap = Math.max(maxGap, tileFrames[i] - tileFrames[i - 1])
console.log(JSON.stringify({
  midSessionFrames: mid.length,
  graceArmedMidSession: armed.length,
  graceCancelledMidSession: cancelled.length,
  graceFiredMidSession: fired.length,
  maxGapBetweenTileFramesMs: maxGap,
}, null, 2))
cdp.close(); await closeTab(tab.id)
