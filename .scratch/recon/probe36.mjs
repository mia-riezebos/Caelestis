import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const btn = (label) => `[...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||b.getAttribute('aria-label')||'').trim() === '${label}')`
const snapshot = (label) => cdp.evaluate(`(() => {
  const b = ${btn(label)}
  if (!b) return null
  const s = getComputedStyle(b)
  return { cls: b.className, bg: s.backgroundColor, color: s.color, radius: s.borderRadius, border: s.borderColor }
})()`)

console.log('Overlays CLOSED :', JSON.stringify(await snapshot('Overlays')))
await cdp.evaluate(`${btn('Overlays')}.click()`)
await sleep(900)
console.log('Overlays OPEN   :', JSON.stringify(await snapshot('Overlays')))

// What did opening it put on screen, and where does it sit in the stacking order?
const panel = await cdp.evaluate(`(() => {
  const seen = []
  for (const el of document.querySelectorAll('div,aside,section,ul')) {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.width < 150 || r.height < 100) continue
    if (s.position !== 'fixed' && s.position !== 'absolute') continue
    if (s.zIndex === 'auto' && s.position === 'absolute') continue
    seen.push({ cls: el.className.toString().slice(0, 90), z: s.zIndex, pos: s.position,
      radius: s.borderRadius, bg: s.backgroundColor.slice(0, 24), shadow: s.boxShadow.slice(0, 40),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
  }
  return seen.slice(0, 12)
})()`)
console.log('\\nfixed/absolute layers while Overlays is open:')
for (const p of panel) console.log(' ', JSON.stringify(p))

// The z-index of the map canvas and of the rail, which bracket where ours must sit.
console.log('\\nstacking context:', JSON.stringify(await cdp.evaluate(`(() => {
  const c = document.querySelector('canvas.maplibregl-canvas')
  const rail = ${btn('Overlays')}?.parentElement
  const chain = []
  let el = rail
  while (el && el !== document.body) {
    const s = getComputedStyle(el)
    if (s.zIndex !== 'auto' || s.position !== 'static') chain.push({ cls: el.className.toString().slice(0,60), z: s.zIndex, pos: s.position })
    el = el.parentElement
  }
  return { canvasZ: getComputedStyle(c.parentElement).zIndex, canvasPos: getComputedStyle(c.parentElement).position, railChain: chain }
})()`)))
// DaisyUI radius tokens, so ours match rather than approximate.
console.log('\\nradius tokens:', JSON.stringify(await cdp.evaluate(`(() => {
  const cs = getComputedStyle(document.documentElement)
  const out = {}
  for (const n of ['--radius-box','--radius-field','--radius-selector','--rounded-box','--rounded-btn','--size-field'])
    out[n] = cs.getPropertyValue(n).trim() || null
  return out
})()`)))
cdp.close(); await closeTab(tab.id)
