import { readFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
// Watch every frame: does a tile-less frame ever happen *while the overlay has something drawn*?
// That is the only case the 250ms grace protects against.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__t = { tileless: [], lastTileAt: 0, overlayHadContent: false, clearedAt: 0 }
  const nativeRaf = requestAnimationFrame
  // Sample the overlay every frame so we know whether a clear was visible or a no-op.
  const tick = () => {
    const c = document.querySelector('canvas[data-wts-overlay]')
    if (c) {
      const ctx = c.getContext('2d')
      try {
        const d = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data
        let any = false
        for (let i = 3; i < d.length; i += 400) if (d[i] !== 0) { any = true; break }
        if (any) { window.__t.overlayHadContent = true; window.__t.lastPaintAt = performance.now() }
        else if (window.__t.overlayHadContent && !window.__t.clearedAt) {
          window.__t.clearedAt = performance.now()
        }
      } catch {}
    }
    nativeRaf(tick)
  }
  nativeRaf(tick)
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(11_000)
await cdp.evaluate('window.__t.overlayHadContent=false; window.__t.clearedAt=0; window.__t.baseline=performance.now()')

// Zoom out past the threshold in one go and time how long the overlay lingers.
for (let i = 0; i < 6; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 240 })
  await sleep(120)
}
await sleep(3_000)
const out = await cdp.evaluate(`(() => {
  const t = window.__t
  return {
    lastVisiblePaintAfterZoomStart: t.lastPaintAt ? Math.round(t.lastPaintAt - t.baseline) : null,
    overlayClearedAfterZoomStart: t.clearedAt ? Math.round(t.clearedAt - t.baseline) : null,
    lingerMs: t.clearedAt && t.lastPaintAt ? Math.round(t.clearedAt - t.lastPaintAt) : null,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
