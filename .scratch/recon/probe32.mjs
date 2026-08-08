import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)
const out = await cdp.evaluate(`(() => {
  const topRight = document.querySelector('.maplibregl-ctrl-top-right')
  const btns = [...document.querySelectorAll('button')]
  const styled = (el) => {
    const s = getComputedStyle(el)
    return { w: el.offsetWidth, h: el.offsetHeight, cls: el.className,
      radius: s.borderRadius, bg: s.backgroundColor, color: s.color,
      shadow: s.boxShadow, border: s.border, gap: s.gap, margin: s.margin }
  }
  // The right-hand control stack is where the Overlays button lives.
  const stack = topRight ? [...topRight.querySelectorAll('button')] : []
  return {
    topRightHTML: topRight ? topRight.outerHTML.slice(0, 1800) : null,
    stackCount: stack.length,
    stackButtons: stack.map(styled),
    containerStyle: topRight ? (() => { const s = getComputedStyle(topRight)
      return { display: s.display, flexDirection: s.flexDirection, gap: s.gap, padding: s.padding, alignItems: s.alignItems } })() : null,
    // Is DaisyUI present? Its classes are distinctive.
    daisyClasses: [...new Set([...document.querySelectorAll('[class]')].flatMap(e => e.className.toString().split(/\\s+/))
      .filter(c => /^(btn|card|drawer|menu|modal|tooltip|badge|toggle|checkbox|range|tabs|join|collapse|dropdown|swap|indicator|divider|alert)(-|$)/.test(c)))].slice(0, 40),
    htmlDataTheme: document.documentElement.getAttribute('data-theme'),
    bodyClass: document.body.className,
  }
})()`)
console.log(JSON.stringify(out, null, 2).slice(0, 6000))
cdp.close(); await closeTab(tab.id)
