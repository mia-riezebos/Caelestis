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
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)
await cdp.evaluate('window.__wts.clear()')
for (let i = 0; i < 8; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 300 })
  await sleep(140)
}
await sleep(2500)
const out = await cdp.evaluate(`(() => {
  const ev = window.__wts.events()
  const lastTile = [...ev].reverse().find(e => e.category === 'frame' && e.data && e.data.quads > 0)
  const cleared = ev.find(e => e.category === 'clear' && e.message.includes('grace elapsed'))
  const armed = ev.find(e => e.category === 'clear' && e.message.includes('arming'))
  return {
    lastFrameWithTilesAt: lastTile ? lastTile.at : null,
    graceArmedAt: armed ? armed.at : null,
    overlayClearedAt: cleared ? cleared.at : null,
    lagFromLastTileToClear: lastTile && cleared ? cleared.at - lastTile.at : null,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
