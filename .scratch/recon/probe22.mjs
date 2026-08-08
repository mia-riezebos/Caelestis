import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
// Which Response methods does wplace actually use on a tile, and does it clone first?
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__m = { calls: [] }
  const T = /\\/files\\/s\\d+\\/tiles\\/(\\d+)\\/(\\d+)\\.png/
  const nf = window.fetch
  window.fetch = async function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || String(a[0])
    const res = await nf.apply(this, a)
    if (!T.test(u)) return res
    const note = (name) => window.__m.calls.push(name)
    for (const name of ['blob', 'arrayBuffer', 'clone', 'text', 'json']) {
      const orig = res[name].bind(res)
      Object.defineProperty(res, name, { value: (...args) => { note(name); return orig(...args) }, configurable: true })
    }
    Object.defineProperty(res, 'body', {
      get() { note('body'); return Object.getOwnPropertyDescriptor(Response.prototype, 'body').get.call(res) },
      configurable: true,
    })
    return res
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)
const out = await cdp.evaluate(`(() => {
  const c = {}
  for (const n of window.__m.calls) c[n] = (c[n] || 0) + 1
  return { order: window.__m.calls.slice(0, 12), counts: c }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
