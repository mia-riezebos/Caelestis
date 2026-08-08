import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Debugger.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
const scripts = []
cdp.on((m) => { if (m.method === 'Debugger.scriptParsed') scripts.push(m.params) })
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.42&lng=5.00&zoom=13' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 90000, label: 'load' })
await sleep(12000)
const ev = (js) => cdp.evaluate(js)

// Which app modules mention the map at all, and what do they export?
const appScripts = scripts.filter((s) => s.url.includes('_app/immutable'))
console.log('app modules loaded:', appScripts.length)
const interesting = []
for (const sc of appScripts) {
  const got = await cdp.send('Debugger.getScriptSource', { scriptId: sc.scriptId }).catch(() => null)
  if (got === null) continue
  const src = got.scriptSource
  const camera = ['flyTo(', 'jumpTo(', 'easeTo(', 'setCenter('].reduce((n, p) => n + (src.split(p).length - 1), 0)
  const hasMapLibre = src.includes('maplibregl-canvas') || src.includes('maplibregl-map')
  if (camera > 0 || hasMapLibre) interesting.push({ url: sc.url, camera, hasMapLibre, size: src.length })
}
interesting.sort((a, b) => b.camera - a.camera)
for (const i of interesting.slice(0, 6)) console.log(`  ${i.url.split('/').pop().padEnd(24)} camera=${String(i.camera).padStart(3)} maplibreDom=${i.hasMapLibre} ${Math.round(i.size/1024)}kb`)

// Re-import each and look for anything holding a live map.
console.log('\nexports that look like a live map:')
for (const i of interesting.slice(0, 8)) {
  const r = await ev(`(async () => {
    try {
      const m = await import(${JSON.stringify(i.url)})
      const out = []
      for (const [k, v] of Object.entries(m)) {
        if (v && typeof v.flyTo === 'function') { globalThis.__map = v; out.push(k + ':MAP') ; continue }
        // Svelte stores expose subscribe; the value inside may be the map.
        if (v && typeof v.subscribe === 'function') {
          let inner = null
          try { v.subscribe((x) => { inner = x })() } catch {}
          if (inner && typeof inner.flyTo === 'function') { globalThis.__map = inner; out.push(k + ':STORE->MAP') }
          else out.push(k + ':store(' + (inner === null ? 'null' : typeof inner) + ')')
        }
      }
      return out.join(' | ') || '(nothing map-like)'
    } catch (e) { return 'import failed: ' + e.message }
  })()`)
  console.log(`  ${i.url.split('/').pop().padEnd(24)} ${String(r).slice(0, 160)}`)
  if (String(r).includes('MAP')) break
}
console.log('\ncaptured a map?', await ev("typeof globalThis.__map?.flyTo === 'function'"))
console.log('zoom now       :', await ev("globalThis.__map?.getZoom?.() ?? 'n/a'"))
cdp.close(); await closeTab(tab.id)
