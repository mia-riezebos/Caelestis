import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

// Is our overlay a frame behind MapLibre? Tag each of MapLibre's render tasks, then see which
// task our flush actually runs in, for rAF scheduling versus a microtask.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  let task = 0
  let inTask = false
  const R = { rafSamples: [], microSamples: [] }
  window.__R = R

  // A task id that changes once per JS task. Incremented lazily at the first GL draw of a batch,
  // and reset by a microtask, so every synchronous render batch gets its own id.
  const beginBatch = () => {
    if (inTask) return task
    inTask = true
    task++
    queueMicrotask(() => { inTask = false })
    return task
  }

  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (t, ...rest) {
    const gl = native.call(this, t, ...rest)
    if (!String(t).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    const nd = gl.drawElements.bind(gl)
    gl.drawElements = function (...a) {
      const drawTask = beginBatch()
      if (R.rafSamples.length < 40) {
        requestAnimationFrame(() => R.rafSamples.push({ drawTask, flushTask: task }))
      }
      if (R.microSamples.length < 40) {
        queueMicrotask(() => R.microSamples.push({ drawTask, flushTask: task }))
      }
      return nd(...a)
    }
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(6_000)
// Drive a real pan so several render batches happen back to back.
const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
await mouse('mousePressed', 700, 450)
for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', 700 - i * 25, 450 + i * 8); await sleep(60) }
await mouse('mouseReleased', 450, 530)
await sleep(3_000)

const out = await cdp.evaluate(`(() => {
  const lag = (s) => {
    const d = s.map(x => x.flushTask - x.drawTask)
    const counts = {}
    for (const n of d) counts[n] = (counts[n] || 0) + 1
    return { n: s.length, lagByTasks: counts }
  }
  return { requestAnimationFrame: lag(window.__R.rafSamples), queueMicrotask: lag(window.__R.microSamples) }
})()`)
console.log(JSON.stringify(out, null, 2))
cdp.close(); await closeTab(tab.id)
