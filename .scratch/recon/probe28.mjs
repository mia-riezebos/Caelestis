import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(11_000)

// Sample both sides of the question every 100ms: does our overlay still have ink, and is wplace
// still drawing tiles? Whole canvas, downsampled — the earlier probe missed the square by only
// looking at a corner.
const sample = () => cdp.evaluate(`(() => {
  const c = document.querySelector('canvas[data-wts-overlay]')
  if (!c) return { ink: -1 }
  const s = document.createElement('canvas'); s.width = 60; s.height = 40
  const sc = s.getContext('2d'); sc.drawImage(c, 0, 0, 60, 40)
  const d = sc.getImageData(0, 0, 60, 40).data
  let ink = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++
  const counters = window.__wts.counters()
  const clears = Object.fromEntries(Object.entries(counters).filter(([k]) => k.startsWith('clear:')))
  return { ink, clears, frames: counters['frame:rendered'] ?? 0 }
})()`)

console.log('t=0 baseline:', JSON.stringify(await sample()))
const t0 = Date.now()
// Zoom out with the on-screen minus button, the way a person does.
await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '-')
  window.__minus = b; return !!b
})()`)
for (let i = 0; i < 3; i++) {
  await cdp.evaluate('window.__minus && window.__minus.click()')
  await sleep(80)
}
const timeline = []
for (let i = 0; i < 30; i++) {
  timeline.push({ t: Date.now() - t0, ...(await sample()) })
  await sleep(150)
}
console.log('\nt(ms)  ink  frames  clear counters')
for (const r of timeline) {
  if (timeline.indexOf(r) % 4 === 0)
    console.log(`${String(r.t).padStart(5)}  ${String(r.ink).padStart(4)}  ${String(r.frames).padStart(6)}  ${JSON.stringify(r.clears)}`)
}
const lastInk = timeline.filter(r => r.ink > 0).pop()
console.log('\nlast frame with overlay ink at t =', lastInk ? lastInk.t : 'never', 'ms after zoom-out began')
cdp.close(); await closeTab(tab.id)
