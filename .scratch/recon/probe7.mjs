import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

// Can a userscript reach the MapLibre Map instance? Nothing is on window, so try the routes a
// document-start shim actually has: catch the canvas at getContext time and look for back-refs.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  window.__m = { getContextCalls: [], canvasSeen: null }
  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    window.__m.getContextCalls.push({ type, cls: this.className })
    if (String(type).startsWith('webgl')) window.__m.canvasSeen = this
    return nativeGetContext.call(this, type, ...rest)
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const out = await cdp.evaluate(`(() => {
  const canvas = document.querySelector('canvas.maplibregl-canvas')
  const container = document.querySelector('.maplibregl-map')
  const ownKeys = (o) => o ? Object.getOwnPropertyNames(o).filter(k => !/^(align|aria|on|webkit|access|auto|child|class|client|content|current|dataset|dir|draggable|elem|enter|first|hidden|id|inert|inner|input|is|item|lang|last|local|namespace|next|node|nonce|offset|outer|owner|parent|part|prefix|previous|role|scroll|shadow|slot|spellcheck|style|tab|tag|text|title|translate|virtual|writing)/.test(k)) : []
  const hidden = (el) => el ? Object.keys(el).filter(k => k.startsWith('_') || k.startsWith('__')) : []
  return {
    getContextCalls: window.__m.getContextCalls.slice(0, 6),
    canvasCaptured: !!window.__m.canvasSeen,
    canvasHiddenKeys: hidden(canvas),
    containerHiddenKeys: hidden(container),
    containerOwn: ownKeys(container).slice(0, 25),
    // Svelte 5 keeps component state off the DOM, but check the usual escape hatches.
    svelteKeys: container ? Object.keys(container).filter(k => /svelte|\\$\\$/i.test(k)) : [],
    windowMapish: Object.keys(window).filter(k => /map|gl|wplace/i.test(k)).slice(0, 20),
  }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
