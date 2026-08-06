import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
// A retina viewport: canvas.width is twice the CSS width, which is the case the overlay sizing
// has been assuming but never actually ran under.
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(14_000)
const info = await cdp.evaluate(`(() => {
  const map = document.querySelector('canvas.maplibregl-canvas')
  const ours = document.querySelector('canvas[data-wts-overlay]')
  return { dpr: devicePixelRatio,
    map: map && { w: map.width, h: map.height, css: map.clientWidth + 'x' + map.clientHeight },
    overlay: ours && { w: ours.width, h: ours.height, css: ours.clientWidth + 'x' + ours.clientHeight } }
})()`)
console.log(JSON.stringify(info))
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/wts-dpr2.png', Buffer.from(data, 'base64'))
cdp.close(); await closeTab(tab.id)
