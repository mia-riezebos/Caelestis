import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
await sleep(11000)
console.log('rail buttons:', await cdp.evaluate("[...document.querySelectorAll('button')].map(b=>(b.title||b.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0,20).join(' | ')"))
// Watch what changes when the map moves without a reload.
await cdp.evaluate(`(() => {
  window.__nav = { urlChanges: [], history: 0 }
  const ps = history.pushState.bind(history), rs = history.replaceState.bind(history)
  history.pushState = (...a) => { window.__nav.history++; window.__nav.urlChanges.push('push ' + a[2]); return ps(...a) }
  history.replaceState = (...a) => { window.__nav.history++; window.__nav.urlChanges.push('replace ' + a[2]); return rs(...a) }
})()`)
const before = await cdp.evaluate("location.href")
const dice = await cdp.evaluate("(() => { const b=[...document.querySelectorAll('button')].find(x=>/random/i.test((x.title||x.getAttribute('aria-label')||''))); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()")
console.log('random button:', dice ?? 'not found')
if (dice) {
  const [x, y] = JSON.parse(dice)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(4000)
  console.log('url before  :', before)
  console.log('url after   :', await cdp.evaluate("location.href"))
  console.log('history ops :', await cdp.evaluate("JSON.stringify(window.__nav)"))
}
cdp.close(); await closeTab(tab.id)
