import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Network.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__obs = { tiles: [] }
  const nativeFetch = window.fetch
  const TILE = /\\/files\\/s(\\d+)\\/tiles\\/(\\d+)\\/(\\d+)\\.png/
  window.fetch = async function (...args) {
    const input = args[0]
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    const m = TILE.exec(url)
    if (!m) return nativeFetch.apply(this, args)
    let response
    try {
      response = await nativeFetch.apply(this, args)
    } catch (e) {
      window.__obs.tiles.push({ tile: m[2] + '/' + m[3], threw: String(e) })
      throw e
    }
    const bytes = (await response.clone().arrayBuffer()).byteLength
    window.__obs.tiles.push({
      tile: m[2] + '/' + m[3], status: response.status, ok: response.ok,
      type: response.type, bytes, ct: response.headers.get('content-type'),
    })
    return response
  }
})()
`,
})

const url = 'https://wplace.live/?lat=-79.95649361183774&lng=-1.5093457031250246&zoom=11.305240117706024'
await cdp.send('Page.navigate', { url })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(14_000)

const obs = await cdp.evaluate('window.__obs')
console.log('tiles the page requested here:')
for (const t of obs.tiles) console.log(' ', JSON.stringify(t))

const errors = await cdp.evaluate(`(() => {
  const c = document.querySelector('canvas')
  return { canvas: c ? c.width + 'x' + c.height : null, href: location.href }
})()`)
console.log('page:', JSON.stringify(errors))

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
await import('node:fs').then((fs) =>
  fs.writeFileSync('/tmp/shot-404.png', Buffer.from(shot.data, 'base64')))
cdp.close()
await closeTab(tab.id)
