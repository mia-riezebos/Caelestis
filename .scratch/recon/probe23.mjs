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
const lines = []
cdp.on((m) => { if (m.method === 'Runtime.consoleAPICalled') {
  const t = m.params.args.map(a => a.value ?? (a.preview ? '{'+(a.preview.properties||[]).map(p=>p.name+': '+p.value).join(', ')+'}' : a.description ?? '')).join(' ')
  if (t.includes('[wts')) lines.push(t) } })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)

// Tiles are no-store with s-maxage=5, so wplace re-fetches them. Pan away and back repeatedly to
// force the refresh that previously swapped identities.
const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
for (let round = 0; round < 4; round++) {
  await mouse('mousePressed', 900, 400)
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', 900 - i * 60, 400); await sleep(50) }
  await mouse('mouseReleased', 540, 400)
  await sleep(3000)
  await mouse('mousePressed', 540, 400)
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', 540 + i * 60, 400); await sleep(50) }
  await mouse('mouseReleased', 900, 400)
  await sleep(4000)
}

const verdict = await cdp.evaluate(`(() => {
  const c = window.__wts.counters()
  const key = Object.keys(c)
  return {
    subImageAttributions: key.filter(k => k.startsWith('texture:attributed')).reduce((n,k)=>n+c[k],0),
    dropped: key.filter(k => k.includes('DROPPED')).reduce((n,k)=>n+c[k],0),
    unmatched: key.filter(k => k.includes('unmatched')).reduce((n,k)=>n+c[k],0),
    fellBack: c['bitmap:fell-back-to-byte-length'] ?? 0,
  }
})()`)
const refetches = lines.filter(l => l.includes('[wts:fetch] tile')).length
const reattributed = lines.filter(l => l.includes('replaced:') && !l.includes('replaced: null')).length
const painted = lines.filter(l => l.includes('[wts:draw] painted'))
console.log(JSON.stringify({ ...verdict, tileFetches: refetches, reAttributedInPlace: reattributed,
  paintedZeroCount: painted.filter(l => l.includes('painted 0')).length,
  paintedOneCount: painted.filter(l => l.includes('painted 1')).length }, null, 2))
console.log('\nlast 4 paints:'); console.log(painted.slice(-4).join('\n'))
cdp.close(); await closeTab(tab.id)
