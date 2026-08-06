import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

// Patch every Web API MapLibre's constructor touches, and for each thing we capture, ask:
// does its object graph contain something that looks like the Map?
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const hits = { resizeObserver: [], listeners: [], mutation: [], raf: 0, canvases: [] }
  window.__h = hits

  const looksLikeMap = (o) => o && typeof o === 'object' &&
    (typeof o.getCanvas === 'function' || (o.transform && typeof o.triggerRepaint === 'function'))

  // Walk own enumerable + underscore props one level for anything map-shaped.
  const scan = (root, label) => {
    if (!root || (typeof root !== 'object' && typeof root !== 'function')) return null
    if (looksLikeMap(root)) return { label, path: '<self>' }
    let keys = []
    try { keys = Object.getOwnPropertyNames(root) } catch { return null }
    for (const k of keys) {
      let v
      try { v = root[k] } catch { continue }
      if (looksLikeMap(v)) return { label, path: k }
      if (v && typeof v === 'object' && (k === '_map' || k === 'map')) return { label, path: k + '(shallow)' }
    }
    return null
  }
  window.__scan = scan

  const NativeRO = window.ResizeObserver
  window.ResizeObserver = class extends NativeRO {
    constructor(cb) { super(cb); hits.resizeObserver.push({ cb, fnProps: Object.getOwnPropertyNames(cb) }) }
    observe(el, ...r) { hits.resizeObserver.at(-1).target = el && el.className; return super.observe(el, ...r) }
  }

  const nativeAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, listener, ...rest) {
    const cls = this && this.className
    if (typeof cls === 'string' && cls.includes('maplibregl')) {
      hits.listeners.push({
        type, cls,
        kind: typeof listener,
        isObject: listener && typeof listener === 'object',
        props: listener && typeof listener === 'object' ? Object.getOwnPropertyNames(listener).slice(0, 12) : [],
        fnName: typeof listener === 'function' ? listener.name : null,
      })
      window.__lastListeners = window.__lastListeners || []
      window.__lastListeners.push(listener)
    }
    return nativeAdd.call(this, type, listener, ...rest)
  }

  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...r) {
    if (String(type).startsWith('webgl')) { hits.canvases.push({ cls: this.className }); window.__glCanvas = this }
    return nativeGetContext.call(this, type, ...r)
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const out = await cdp.evaluate(`(() => {
  const h = window.__h
  const found = []
  for (const l of (window.__lastListeners || [])) {
    const r = window.__scan(l, 'listener')
    if (r) found.push(r)
  }
  for (const r of h.resizeObserver) {
    const s = window.__scan(r.cb, 'resizeObserver-cb')
    if (s) found.push(s)
  }
  return {
    resizeObservers: h.resizeObserver.map(r => ({ target: r.target, fnProps: r.fnProps })),
    listenerSample: h.listeners.slice(0, 10),
    listenerCount: h.listeners.length,
    objectListeners: h.listeners.filter(l => l.isObject).length,
    glCanvas: !!window.__glCanvas,
    mapFoundVia: found,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
