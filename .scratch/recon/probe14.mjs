import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
(() => {
  const S = { names: new Map(), texTile: new Map(), curMatrix: null, curTex: null, draws: [], tileOfBitmap: new WeakMap() }
  window.__a = S

  // Our fetch shim already knows which tile each blob is. Carry that through the ImageBitmap so
  // the texture upload can be attributed to a tile.
  const nativeFetch = window.fetch
  const TILE = /\\/files\\/s\\d+\\/tiles\\/(\\d+)\\/(\\d+)\\.png/
  const nativeCreateImageBitmap = window.createImageBitmap
  const pendingBlobs = new WeakMap()
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0])
    const m = TILE.exec(url)
    const res = await nativeFetch.apply(this, args)
    if (!m) return res
    const blob = await res.clone().blob()
    pendingBlobs.set(blob, m[1] + '/' + m[2])
    return new Response(blob, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  window.createImageBitmap = async function (src, ...rest) {
    const bmp = await nativeCreateImageBitmap.call(this, src, ...rest)
    const tile = pendingBlobs.get(src)
    if (tile) S.tileOfBitmap.set(bmp, tile)
    return bmp
  }

  const native = HTMLCanvasElement.prototype.getContext
  let wrapped = false
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = native.call(this, type, ...rest)
    if (!String(type).startsWith('webgl') || !gl || wrapped) return gl
    wrapped = true
    window.__glCanvas = this

    const nGUL = gl.getUniformLocation.bind(gl)
    gl.getUniformLocation = (p, n) => { const l = nGUL(p, n); if (l) S.names.set(l, n); return l }

    const nUM = gl.uniformMatrix4fv.bind(gl)
    gl.uniformMatrix4fv = function (loc, t, v, ...r) {
      if (S.names.get(loc) === 'u_projection_matrix') S.curMatrix = Array.from(v).slice(0, 16)
      return nUM(loc, t, v, ...r)
    }
    const nTI = gl.texImage2D.bind(gl)
    gl.texImage2D = function (...a) {
      const src = a[a.length - 1]
      if (src && src instanceof ImageBitmap && src.width === 1000 && src.height === 1000) {
        S.texTile.set(S.curTex, '1000x1000')
      }
      return nTI(...a)
    }
    const nBT = gl.bindTexture.bind(gl)
    gl.bindTexture = function (target, tex) { S.curTex = tex; return nBT(target, tex) }

    const record = (name) => {
      const n = gl[name].bind(gl)
      gl[name] = function (...a) {
        const tile = S.texTile.get(S.curTex)
        if (tile && S.curMatrix && S.draws.length < 400) {
          S.draws.push({ tile, m: S.curMatrix })
        }
        return n(...a)
      }
    }
    record('drawArrays'); record('drawElements')
    return gl
  }
})()
`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.37&lng=4.90&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(14_000)

const out = await cdp.evaluate(`(() => {
  const S = window.__a, c = window.__glCanvas
  // Transform a tile-local point through the captured matrix into CSS pixels.
  const toScreen = (m, x, y) => {
    const cx = m[0]*x + m[4]*y + m[12], cy = m[1]*x + m[5]*y + m[13], cw = m[3]*x + m[7]*y + m[15]
    return [ ((cx/cw) * 0.5 + 0.5) * c.width, (1 - ((cy/cw) * 0.5 + 0.5)) * c.height ]
  }
  const seen = new Map()
  for (const d of S.draws) { const k = d.m.join(','); if (!seen.has(k)) seen.set(k, d.m) }
  const out = []
  for (const [, m] of seen) {
    for (const extent of [8192, 1]) {
      const tl = toScreen(m, 0, 0), br = toScreen(m, extent, extent)
      const size = [+(br[0]-tl[0]).toFixed(1), +(br[1]-tl[1]).toFixed(1)]
      if (Math.abs(size[0]) > 1 && Math.abs(size[0]) < 20000)
        out.push({ extent, tl: tl.map(n=>+n.toFixed(1)), size })
    }
  }
  return { canvas: c.width + 'x' + c.height, distinctMatrices: seen.size, quads: out.slice(0, 14) }
})()`)
console.log(JSON.stringify(out, null, 2).slice(0, 3000))
cdp.close(); await closeTab(tab.id)
