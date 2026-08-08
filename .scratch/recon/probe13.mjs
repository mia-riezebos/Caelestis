import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  // getUniformLocation takes the uniform's NAME as a string. Hooking it builds a
  // location -> name map, so uniformMatrix4fv stops being an anonymous blob of 16 floats.
  const state = { names: new Map(), uploads: new Map(), shaders: new Set(), textures: [] }
  window.__u = state
  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = native.call(this, type, ...rest)
    if (!String(type).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    window.__glCanvas = this

    const nativeGetUniformLocation = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = function (program, name) {
      const loc = nativeGetUniformLocation(program, name)
      if (loc) state.names.set(loc, name)
      return loc
    }
    const nativeUniformMatrix4fv = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (loc, transpose, value, ...r) {
      const name = state.names.get(loc) || '<unknown>'
      const arr = Array.from(value).slice(0, 16)
      const entry = state.uploads.get(name) || { count: 0, samples: [] }
      entry.count++
      if (entry.samples.length < 3) entry.samples.push(arr)
      entry.last = arr
      state.uploads.set(name, entry)
      return nativeUniformMatrix4fv(loc, transpose, value, ...r)
    }
    // Which images become textures tells us how to bind a tile to its matrix later.
    const nativeTexImage2D = gl.texImage2D.bind(gl)
    gl.texImage2D = function (...args) {
      const src = args[args.length - 1]
      if (src && (src instanceof ImageBitmap || src instanceof HTMLImageElement)) {
        state.textures.push({ kind: src.constructor.name, w: src.width, h: src.height })
      }
      return nativeTexImage2D(...args)
    }
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const out = await cdp.evaluate(`(() => {
  const s = window.__u
  const uploads = [...s.uploads.entries()]
    .map(([name, e]) => ({ name, count: e.count, distinct: new Set(e.samples.map(a=>a.join(','))).size, last4: e.last.slice(0,4).map(n=>+n.toPrecision(6)) }))
    .sort((a,b) => b.count - a.count)
  return {
    uniformNamesSeen: [...new Set([...s.names.values()])].sort(),
    matrixUniforms: uploads,
    tileTextures: s.textures.filter(t => t.w === 1000 || t.h === 1000).length,
    textureSizes: [...new Set(s.textures.map(t => t.w + 'x' + t.h))].slice(0, 12),
    canvas: window.__glCanvas ? window.__glCanvas.width + 'x' + window.__glCanvas.height : null,
  }
})()`)
console.log(JSON.stringify(out, null, 2).slice(0, 4000))
cdp.close(); await closeTab(tab.id)
