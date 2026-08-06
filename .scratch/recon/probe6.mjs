import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable')

const net = []
cdp.on((m) => {
  if (m.method === 'Network.responseReceived' && /\/tiles\//.test(m.params.response.url)) {
    net.push({
      url: m.params.response.url.split('/tiles/')[1],
      status: m.params.response.status,
      fromSW: m.params.response.fromServiceWorker,
      fromCache: m.params.response.fromDiskCache,
      len: m.params.response.headers['content-length'],
    })
  }
})

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__o = { pageSaw: [], swAtInstall: null }
  window.__o.swAtInstall = !!(navigator.serviceWorker && navigator.serviceWorker.controller)
  const nf = window.fetch
  const T = /\\/tiles\\/(\\d+)\\/(\\d+)\\.png/
  window.fetch = async function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || String(a[0])
    const m = T.exec(u)
    if (!m) return nf.apply(this, a)
    const r = await nf.apply(this, a)
    window.__o.pageSaw.push({ tile: m[1]+'/'+m[2], status: r.status, type: r.type,
      bytes: (await r.clone().arrayBuffer()).byteLength })
    return r
  }
})()
`,
})

await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-79.95649361183774&lng=-1.5093457031250246&zoom=11.305240117706024' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const o = await cdp.evaluate(`(async () => {
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : []
  return {
    ...window.__o,
    swControllerNow: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    swScriptURLs: regs.map(r => (r.active && r.active.scriptURL) || (r.installing && r.installing.scriptURL) || 'unknown'),
    pageSaw: window.__o.pageSaw.slice(0, 6),
  }
})()`)
console.log('PAGE VIEW :', JSON.stringify(o, null, 2))
console.log('NETWORK   :', JSON.stringify(net.slice(0, 6), null, 2))
console.log('network statuses:', [...new Set(net.map(n => n.status))], 'count', net.length)

// Same tile fetched from the page with cache bypass, to separate "server 404" from "cached 200".
const direct = await cdp.evaluate(`(async () => {
  const one = async (u, init) => { const r = await fetch(u, init)
    return { status: r.status, bytes: (await r.arrayBuffer()).byteLength } }
  const base = 'https://backend.wplace.live/files/s0/tiles/1015/1816.png'
  return {
    plain: await one(base),
    cacheBusted: await one(base + '?x=' + Math.random()),
    noStore: await one(base, { cache: 'reload' }),
  }
})()`)
console.log('DIRECT FROM PAGE:', JSON.stringify(direct))
cdp.close(); await closeTab(tab.id)
