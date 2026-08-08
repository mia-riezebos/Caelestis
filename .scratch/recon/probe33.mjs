import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)
const out = await cdp.evaluate(`(() => {
  const vw = innerWidth
  // The right-hand stack: buttons whose right edge sits near the viewport's right edge.
  const right = [...document.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect()
    return r.width > 20 && r.right > vw - 120 && r.top > 0 && r.top < innerHeight - 100
  })
  const describe = (b) => {
    const r = b.getBoundingClientRect()
    const s = getComputedStyle(b)
    return {
      cls: b.className,
      title: b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 24),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      radius: s.borderRadius, bg: s.backgroundColor, shadow: s.boxShadow.slice(0, 60),
      svg: (b.querySelector('svg') || {}).outerHTML?.slice(0, 200) ?? null,
    }
  }
  const parent = right.length ? right[0].parentElement : null
  const grandparent = parent?.parentElement
  return {
    count: right.length,
    buttons: right.map(describe),
    parentCls: parent?.className,
    parentStyle: parent ? (() => { const s = getComputedStyle(parent)
      return { display: s.display, flexDirection: s.flexDirection, gap: s.gap, position: s.position,
               right: s.right, top: s.top, padding: s.padding } })() : null,
    grandparentCls: grandparent?.className,
  }
})()`)
console.log(JSON.stringify(out, null, 2).slice(0, 7000))
cdp.close(); await closeTab(tab.id)
