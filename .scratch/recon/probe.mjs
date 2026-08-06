import { Session, closeTab, newTab, sleep } from './cdp.mjs'

const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)

await cdp.send('Network.enable')
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

// Runs in the page's main world before any page script — the timing a `@grant none`
// userscript with `@run-at document-start` gets.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const recon = {
    installedAt: performance.now(),
    fetch: [],
    xhr: [],
    imgSrc: [],
    createImageBitmap: [],
    fetchIdentitySwapped: null,
  }
  window.__recon = recon

  const nativeFetch = window.fetch
  const shim = function fetch(...args) {
    const input = args[0]
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    recon.fetch.push({ url, at: performance.now(), stack: new Error().stack })
    return nativeFetch.apply(this, args)
  }
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    writable: true,
    value: shim,
  })
  // If wplace reassigns window.fetch later, this tells us our shim was displaced.
  recon.checkIdentity = () => {
    recon.fetchIdentitySwapped = window.fetch !== shim
    return recon.fetchIdentitySwapped
  }

  const nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    recon.xhr.push({ method, url: String(url), at: performance.now() })
    return nativeOpen.call(this, method, url, ...rest)
  }

  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: imgSrc.enumerable,
    get() { return imgSrc.get.call(this) },
    set(value) {
      recon.imgSrc.push({ url: String(value), at: performance.now() })
      return imgSrc.set.call(this, value)
    },
  })

  const nativeCreateImageBitmap = window.createImageBitmap
  window.createImageBitmap = function (source, ...rest) {
    recon.createImageBitmap.push({
      kind: source && source.constructor ? source.constructor.name : typeof source,
      at: performance.now(),
    })
    return nativeCreateImageBitmap.call(this, source, ...rest)
  }
})()
`,
})

const responses = new Map()
cdp.on((message) => {
  if (message.method === 'Network.responseReceived') {
    const { response, type } = message.params
    responses.set(message.params.requestId, {
      url: response.url,
      status: response.status,
      type,
      mimeType: response.mimeType,
      headers: response.headers,
      remoteAddress: `${response.remoteIPAddress}:${response.remotePort}`,
    })
  }
})

console.log('navigating to https://wplace.live/ ...')
await cdp.send('Page.navigate', { url: 'https://wplace.live/' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
console.log('load fired; settling 12s for tiles')
await sleep(12_000)

const recon = await cdp.evaluate(`(() => {
  window.__recon.checkIdentity()
  const r = window.__recon
  const summarise = (list) => list.slice(0, 200).map(({ stack, ...rest }) => rest)
  return {
    installedAt: r.installedAt,
    fetchIdentitySwapped: r.fetchIdentitySwapped,
    counts: {
      fetch: r.fetch.length,
      xhr: r.xhr.length,
      imgSrc: r.imgSrc.length,
      createImageBitmap: r.createImageBitmap.length,
    },
    fetch: summarise(r.fetch),
    xhr: summarise(r.xhr),
    imgSrc: summarise(r.imgSrc),
    createImageBitmap: summarise(r.createImageBitmap),
    location: location.href,
    title: document.title,
  }
})()`)

const all = [...responses.values()]
const out = {
  recon,
  network: {
    total: all.length,
    tiles: all.filter((r) => /\/tiles\//.test(r.url)),
    documents: all.filter((r) => r.type === 'Document'),
    hosts: [...new Set(all.map((r) => new URL(r.url).host))],
  },
}
console.log(JSON.stringify(out, null, 2).slice(0, 12_000))

await import('node:fs').then((fs) =>
  fs.writeFileSync('.scratch/recon/out-01.json', JSON.stringify({ ...out, allResponses: all }, null, 2)),
)
cdp.close()
await closeTab(tab.id)
