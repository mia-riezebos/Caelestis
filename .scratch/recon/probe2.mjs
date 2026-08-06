import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

// A shim that rewrites tile pixels, exactly as the userscript would: intercept the fetch,
// decode the real tile, stamp over it, hand back a Response wplace cannot tell from the original.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const log = []
  window.__shim = { log, stamped: 0, errors: [] }
  const nativeFetch = window.fetch
  const TILE = /\\/files\\/s(\\d+)\\/tiles\\/(\\d+)\\/(\\d+)\\.png/

  window.fetch = async function (...args) {
    const input = args[0]
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    const match = TILE.exec(url)
    if (!match) return nativeFetch.apply(this, args)

    const response = await nativeFetch.apply(this, args)
    try {
      const blob = await response.clone().blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      // A magenta bar across the top of every tile: unmistakable, and impossible to confuse
      // with wplace's own art.
      context.fillStyle = '#ff00ff'
      context.fillRect(0, 0, bitmap.width, Math.max(24, Math.floor(bitmap.height / 12)))
      const out = await canvas.convertToBlob({ type: 'image/png' })
      window.__shim.stamped++
      log.push({ url, w: bitmap.width, h: bitmap.height, inBytes: blob.size, outBytes: out.size })
      return new Response(out, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      window.__shim.errors.push(String(error))
      return response
    }
  }
})()
`,
})

console.log('navigating...')
await cdp.send('Page.navigate', { url: 'https://wplace.live/' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(10_000)

const shim = await cdp.evaluate('({...window.__shim, log: window.__shim.log.slice(0,10)})')
console.log('INTERCEPTION:', JSON.stringify(shim, null, 2))

// Question 6: what does an out-of-range tile look like, versus an in-range unpainted one?
const probes = await cdp.evaluate(`(async () => {
  const check = async (label, url) => {
    try {
      const r = await fetch(url)
      const b = r.ok ? await r.clone().blob() : null
      return { label, url, status: r.status, type: r.type, bytes: b ? b.size : null,
               contentType: r.headers.get('content-type'),
               acao: r.headers.get('access-control-allow-origin') }
    } catch (e) { return { label, url, error: String(e) } }
  }
  const base = 'https://backend.wplace.live/files/s0/tiles'
  return [
    await check('known painted', base + '/325/1782.png'),
    await check('likely empty in-range', base + '/1/1.png'),
    await check('out of range x', base + '/2048/1782.png'),
    await check('out of range y', base + '/325/2048.png'),
    await check('far out of range', base + '/99999/99999.png'),
  ]
})()`)
console.log('TILE PROBES:', JSON.stringify(probes, null, 2))

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
await import('node:fs').then((fs) =>
  fs.writeFileSync('.scratch/recon/shot-intercepted.png', Buffer.from(shot.data, 'base64')),
)
console.log('screenshot written')

cdp.close()
await closeTab(tab.id)
