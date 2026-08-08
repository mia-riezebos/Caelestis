import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
})

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__shim = { stamped: 0, errors: [], tiles: [] }
  const nativeFetch = window.fetch
  const TILE = /\\/files\\/s(\\d+)\\/tiles\\/(\\d+)\\/(\\d+)\\.png/
  window.fetch = async function (...args) {
    const input = args[0]
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    const match = TILE.exec(url)
    if (!match) return nativeFetch.apply(this, args)
    const response = await nativeFetch.apply(this, args)
    try {
      const bitmap = await createImageBitmap(await response.clone().blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      // Fill the whole tile edge-to-edge so it is visible at any zoom and any pan position.
      ctx.strokeStyle = '#ff00ff'
      ctx.lineWidth = 60
      ctx.strokeRect(0, 0, bitmap.width, bitmap.height)
      ctx.fillStyle = '#ff00ff'
      ctx.fillRect(bitmap.width / 2 - 150, bitmap.height / 2 - 150, 300, 300)
      window.__shim.stamped++
      window.__shim.tiles.push(match[2] + '/' + match[3])
      return new Response(await canvas.convertToBlob({ type: 'image/png' }), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    } catch (error) {
      window.__shim.errors.push(String(error))
      return response
    }
  }
})()
`,
})

// Zoom 11 is one tile per 1000px, so a handful of whole tiles fill the viewport.
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(14_000)

console.log('url after load:', await cdp.evaluate('location.href'))
console.log('shim:', JSON.stringify(await cdp.evaluate('({...window.__shim, tiles: window.__shim.tiles.slice(0,20)})')))

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
await import('node:fs').then((fs) =>
  fs.writeFileSync('.scratch/recon/shot-zoomed.png', Buffer.from(shot.data, 'base64')))
cdp.close()
await closeTab(tab.id)
