/**
 * Run the built userscript in Chromium without installing it in a userscript manager.
 *
 * A Chromium with the debugging port open is started automatically if one is not already running —
 * see `chromium.mjs`. The one case it cannot fix by itself is a Chromium that is *already* running
 * without the port, since the port can only be set at launch; pass `--relaunch` to quit and restart
 * it, or do that by hand.
 *
 *   node apps/userscript/dev-inject.mjs                  # build once, inject, hold the tab open
 *   node apps/userscript/dev-inject.mjs --watch          # rebuild and reload on every source change
 *   node apps/userscript/dev-inject.mjs --url '...'      # start somewhere other than the default view
 *   node apps/userscript/dev-inject.mjs --shot out.png   # screenshot after settling, then exit
 *   node apps/userscript/dev-inject.mjs --verbose        # include wplace's own console output
 *   node apps/userscript/dev-inject.mjs --relaunch       # restart a Chromium that lacks the port
 *
 * What this is and is not: the bundle is installed with
 * `Page.addScriptToEvaluateOnNewDocument`, which runs in the page's main world before any page
 * script. That is the timing and the world a `@grant none` userscript gets. A script with any
 * `@grant` runs in the manager's sandbox instead, and reaches the page only by injecting a
 * `<script>` element — the bridge BlueMarble uses. So this harness is faithful for page-context
 * work and proves nothing about the sandboxed path. Verify that separately before relying on it.
 */
import { spawn } from 'node:child_process'
import { readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureChromium } from './chromium.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, 'dist/wplace-template-server.user.js')
const CDP = 'http://127.0.0.1:9222'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : (argv[index + 1] ?? fallback)
}
const watching = argv.includes('--watch')
/** Pass --verbose to see wplace's own console output alongside ours. */
const verbose = argv.includes('--verbose')
/** Quit an already-running Chromium that has no debugging port, rather than refusing to continue. */
const relaunch = argv.includes('--relaunch')
const shotPath = flag('--shot', null)
// No coordinates by default. wplace restores its own last position on load, so pinning a lat/lng
// only overrode it and dropped every run in the same unrelated place.
const url = flag('--url', 'https://wplace.live/')
const settleMs = Number(flag('--settle', shotPath ? 12_000 : 4_000))

const build = () =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [join(here, 'build.mjs')], { cwd: here, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))))
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * CDP sends objects as previews rather than values, so `arg.value` is undefined for exactly the
 * payloads worth reading. Rebuild something legible from the preview instead of printing nothing.
 */
const renderArg = (arg) => {
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue)
  const preview = arg.preview
  if (preview) {
    const more = preview.overflow ? ', ...' : ''
    if (preview.subtype === 'array') {
      return `[${(preview.properties ?? []).map((p) => p.value).join(', ')}${more}]`
    }
    return `{ ${(preview.properties ?? []).map((p) => `${p.name}: ${p.value}`).join(', ')}${more} }`
  }
  return arg.description ?? arg.type
}

class Tab {
  #ws
  #id = 1
  #pending = new Map()

  static async open() {
    // Start a debuggable Chromium if there is not one already, so this needs no setup by hand.
    await ensureChromium({ relaunch })
    const res = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
    if (!res.ok) {
      throw new Error(`could not open a tab (${res.status})`)
    }
    const target = await res.json()
    const tab = new Tab()
    tab.target = target
    tab.#ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      tab.#ws.addEventListener('open', resolve, { once: true })
      tab.#ws.addEventListener('error', reject, { once: true })
    })
    tab.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const settle = tab.#pending.get(message.id)
        tab.#pending.delete(message.id)
        if (settle)
          (message.error ? settle.reject : settle.resolve)(message.error ?? message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params.args.map(renderArg).join(' ')
        // Match the prefix, not the exact tag. Every debug line is `[wts:fetch]`, `[wts:texture]`
        // and so on, and filtering on `[wts]` silently dropped every one of them.
        if (text.includes('[wts') || verbose) {
          const kind = message.params.type
          const mark = kind === 'warning' ? '  page!' : kind === 'error' ? '  page*' : '  page>'
          console.log(`${mark} ${text}`)
        }
      }
      if (message.method === 'Runtime.exceptionThrown') {
        console.error(
          `  page! ${message.params.exceptionDetails.text}`,
          message.params.exceptionDetails.exception?.description ?? '',
        )
      }
    })
    return tab
  }

  send(method, params = {}) {
    const id = this.#id++
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }
}

const tab = await Tab.open()
await tab.send('Page.enable')
await tab.send('Runtime.enable')

let installed = null
const load = async () => {
  await build()
  const bundle = readFileSync(BUNDLE, 'utf8')
  // addScriptToEvaluateOnNewDocument fires in every frame, including third-party iframes such as
  // Stripe's. A real userscript is gated by `@match`, so gate this the same way — otherwise the
  // harness runs the script in places the shipped script never would, and any bug that causes
  // shows up only here.
  const source = `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`
  if (installed)
    await tab.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed })
  const { identifier } = await tab.send('Page.addScriptToEvaluateOnNewDocument', { source })
  installed = identifier
  await tab.send('Page.navigate', { url })
  console.log(`injected ${(source.length / 1024).toFixed(1)} KB → ${url}`)
}

let initialLoad = load
if (watching) {
  console.log('watching src/ — save to rebuild and reload. Ctrl-C to stop.')
  let debounce = null
  let reloading = false
  let dirty = false
  const reload = async () => {
    if (reloading) {
      dirty = true
      return
    }
    reloading = true
    do {
      dirty = false
      try {
        await load()
      } catch (error) {
        console.error('reload failed:', error.message)
      }
    } while (dirty)
    reloading = false
  }
  initialLoad = reload
  // Register before the first build/navigation: edits during startup become a dirty rerun instead
  // of disappearing into the initial four-second settle window.
  watch(join(here, 'src'), { recursive: true }, () => {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void reload()
    }, 150)
  })
}

await initialLoad()
if (!watching || shotPath) await sleep(settleMs)

if (shotPath) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shotPath, Buffer.from(data, 'base64'))
  console.log(`screenshot → ${shotPath}`)
  await fetch(`${CDP}/json/close/${tab.target.id}`)
  process.exit(0)
}

if (!watching) {
  console.log('tab left open; re-run to reload.')
}
