import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
// Counters tally regardless of the debug flag, so leave logging off and read them at the end.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
const before = await cdp.evaluate('window.__wts.counters()')

const mouse = (t, x, y) => cdp.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: 1, clickCount: 1 })
const wheel = (dy) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: dy })
for (let r = 0; r < 3; r++) {
  await mouse('mousePressed', 900, 400)
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', 900 - i * 50, 400 + i * 10); await sleep(40) }
  await mouse('mouseReleased', 500, 480)
  for (let i = 0; i < 3; i++) { await wheel(-200); await sleep(200) }
  for (let i = 0; i < 3; i++) { await wheel(200); await sleep(200) }
  await sleep(2000)
}
const after = await cdp.evaluate('window.__wts.counters()')
const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0)
const keys = Object.keys(after).filter((k) => k.startsWith('clear:'))
console.log('mid-session, while never crossing the zoom threshold:')
console.log('  frames rendered      :', delta('frame:rendered'))
for (const k of keys) console.log(`  ${k.slice(6).padEnd(52)}: ${delta(k)}`)
cdp.close(); await closeTab(tab.id)
