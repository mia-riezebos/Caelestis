import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('wtsDebug','1') } catch {}`,
})
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
const lines = []
cdp.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.args.map(a => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview.properties?.map(p=>p.name+'='+p.value)) : '')).join(' ')
    if (t.includes('[wts')) lines.push(`${m.params.type.toUpperCase()} ${t}`)
  }
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
console.log('=== after load ===')
console.log(lines.slice(-6).join('\n'))

// Pan and zoom the way a person would, which is when the overlay was reported to vanish.
const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
await mouse('mousePressed', 700, 400)
for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', 700 - i * 35, 400 + i * 20); await sleep(70) }
await mouse('mouseReleased', 420, 560)
await sleep(4_000)
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -400 })
await sleep(5_000)

const summary = await cdp.evaluate(`(() => {
  const c = window.__wts.counters()
  const bad = Object.entries(c).filter(([k]) => /DROPPED|unmatched|could not|rejected|texture-not-a-known|grace elapsed/.test(k))
  return { warnings: Object.fromEntries(bad), frames: c['frame:rendered'] ?? 0,
           attributed: Object.entries(c).filter(([k]) => k.startsWith('texture:attributed')).length }
})()`)
console.log('\n=== warning counters after pan + zoom ===')
console.log(JSON.stringify(summary, null, 2))
console.log('\n=== last warnings seen ===')
console.log(lines.filter(l => l.startsWith('WARNING')).slice(-8).join('\n') || '(none)')
cdp.close(); await closeTab(tab.id)
