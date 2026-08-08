import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)
const before = await cdp.evaluate(`document.querySelectorAll('div').length`)
await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => (b.title||'').trim()==='Overlays').click()`)
await sleep(1200)
// Whatever appeared, describe its surface: radius, padding, shadow, border.
const out = await cdp.evaluate(`(() => {
  const found = []
  for (const el of document.querySelectorAll('div,aside,dialog,section')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (r.width < 180 || r.height < 120) continue
    if (s.borderRadius === '0px') continue
    found.push({
      cls: el.className.toString().slice(0, 80),
      radius: s.borderRadius, padding: s.padding, shadow: s.boxShadow.slice(0, 46),
      bg: s.backgroundColor, border: s.borderWidth,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    })
  }
  return found.slice(0, 8)
})()`)
console.log('divs before/after:', before, await cdp.evaluate(`document.querySelectorAll('div').length`))
for (const f of out) console.log(JSON.stringify(f))
console.log('\ntailwind radius scale present?', JSON.stringify(await cdp.evaluate(`(() => {
  const p = document.createElement('div'); document.body.appendChild(p)
  const out = {}
  for (const c of ['rounded-sm','rounded-md','rounded-lg','rounded-xl','rounded-2xl','rounded-3xl','rounded-box','rounded-full']) {
    p.className = c; out[c] = getComputedStyle(p).borderRadius
  }
  p.remove(); return out
})()`)))
cdp.close(); await closeTab(tab.id)
