import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Debugger.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })

const scripts = []
cdp.on((m) => { if (m.method === 'Debugger.scriptParsed') scripts.push(m.params) })

await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(11000)

// Find the script that defines MapLibre's camera methods.
// Which script actually defines the camera? Count the methods in every one, not just the first hit.
let target = null
let best = 0
for (const sc of scripts.filter((x) => x.url.includes('_app/immutable'))) {
  const got = await cdp.send('Debugger.getScriptSource', { scriptId: sc.scriptId }).catch(() => null)
  if (got === null) continue
  const src = got.scriptSource
  const score = ['flyTo(', 'jumpTo(', 'easeTo(', 'panTo(', 'setCenter('].reduce(
    (n, p) => n + (src.split(p).length - 1), 0)
  if (score > best) { best = score; target = { script: sc, src } }
}
if (target === null) { console.log('no camera methods found'); process.exit(0) }
console.log('camera bundle :', target.script.url.split('/').pop(), '— method occurrences:', best)

// The bundle is one minified line, so a line number locates nothing. Find the column of the method
// definition in the source and break exactly there.
const src = target.src
const candidates = []
for (const pattern of ['flyTo(', 'jumpTo(', 'easeTo(', 'panTo(', 'setCenter(']) {
  let from = 0
  for (;;) {
    const at = src.indexOf(pattern, from)
    if (at === -1) break
    candidates.push({ pattern, at })
    from = at + 1
    if (candidates.length > 30) break
  }
}
console.log('camera method occurrences:', candidates.length)
const bps = []
for (const c of candidates.slice(0, 12)) {
  const r = await cdp.send('Debugger.setBreakpoint', {
    location: { scriptId: target.script.scriptId, lineNumber: 0, columnNumber: c.at + c.pattern.length },
  }).catch(() => null)
  if (r?.breakpointId) bps.push({ ...c, id: r.breakpointId })
}
console.log('breakpoints set:', bps.length)

let paused = null
cdp.on((m) => { if (m.method === 'Debugger.paused' && paused === null) paused = m.params })

const real = async (sel) => {
  const at = JSON.parse(await cdp.evaluate(`(() => { const b = ${sel}; if(!b) return 'null'; const r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]) })()`))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 })
}
await real("[...document.querySelectorAll('button')].find(x=>(x.title||'').trim()==='Search')")
await sleep(2000)
await cdp.evaluate(`(() => { const i=[...document.querySelectorAll('input')].find(x=>(x.placeholder||'').trim()==='Search' && x.offsetParent); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'48.8566, 2.3522'); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(2500)
const resultThere = await cdp.evaluate("!![...document.querySelectorAll('li,button,[role=option]')].find(e=>/coordinates/i.test(e.textContent||'') && e.offsetParent)")
console.log('result present:', resultThere)
const url0 = await cdp.evaluate("location.href")
await real("[...document.querySelectorAll('li,button,[role=option]')].find(e=>/coordinates/i.test(e.textContent||'') && e.offsetParent)")
await sleep(4000)
console.log('url after click:', (await cdp.evaluate("location.href")) !== url0, '->', (await cdp.evaluate("location.href")).slice(0,60))

if (paused === null) { console.log('never paused — the click did not reach flyTo'); process.exit(0) }
console.log('PAUSED. call stack:')
for (const f of paused.callFrames.slice(0, 6)) console.log('  ', f.functionName || '(anon)', 'line', f.location.lineNumber)
const self = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: 'this && typeof this.flyTo === "function" ? (globalThis.__map = this, "captured: " + Object.getPrototypeOf(this).constructor.name) : "this is not a map"' })
console.log('this =>', self.result.value)
await cdp.send('Debugger.resume').catch(() => {})
await sleep(1500)
console.log('window.__map usable:', await cdp.evaluate("typeof window.__map?.flyTo === 'function' && typeof window.__map?.getZoom === 'function'"))
console.log('zoom via map:', await cdp.evaluate("window.__map?.getZoom?.() ?? 'n/a'"))
cdp.close(); await closeTab(tab.id)
