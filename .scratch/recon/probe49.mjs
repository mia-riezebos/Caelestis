import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const FILE = join(homedir(), 'Downloads', 'cba.wplace')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.removeItem('caelestis.state.v1')}catch{}` })
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n' + bundle + '\n}',
})
let chooser = null
const notes = []
cdp.on((m) => {
  if (m.method === 'Page.fileChooserOpened') chooser = m.params
  if (m.method === 'Runtime.exceptionThrown') notes.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
    if (t.includes('[wts') || m.params.type === 'error') notes.push(m.params.type.toUpperCase() + ' ' + t.slice(0, 200))
  }
})

await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-78.87&lng=-122.72&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60000, label: 'load' })
for (let i = 0; i < 24; i++) { if (await cdp.evaluate("!!document.getElementById('wts-rail-button')")) break; await sleep(500) }
await sleep(2500)
const ev = (js) => cdp.evaluate(js)
const shot = async (n) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')) }

await ev("document.getElementById('wts-rail-button').click()")
await sleep(500)
await ev("[...document.querySelectorAll('#wts-panel button')].find(b=>b.textContent.trim()==='Import a template').click()")
await sleep(1000)
if (chooser !== null) {
  await cdp.send('DOM.setFileInputFiles', { files: [FILE], backendNodeId: chooser.backendNodeId })
} else {
  console.log('no chooser event; targeting the input element directly')
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: "input[type=file]" })
  if (!found.nodeId) { console.log('no file input in the document'); process.exit(1) }
  await cdp.send('DOM.setFileInputFiles', { files: [FILE], nodeId: found.nodeId })
}
console.log('file handed over, decoding…')
for (let i = 0; i < 60; i++) {
  const t = await ev("document.querySelector('#wts-panel [data-wts-toast]')?.textContent ?? ''")
  if (t.includes('Imported') || t.includes('Could not')) { console.log('toast:', t); break }
  await sleep(1000)
}
const urlAtImport = await ev("location.href")
console.log('templates :', await ev("JSON.stringify(window.__wtsLocal ?? [])"))
// Navigation is a closed loop; give it room to settle.
await sleep(12000)
console.log('url same? :', (await ev("location.href")) === urlAtImport, '(no reload means the import survives)')
console.log('still there:', await ev("JSON.stringify((window.__wtsLocal ?? []).map(t=>t.name))"))
console.log('scale ppc :', await ev("(() => { const q = window.__wts; return 'see notes' })()"))
console.log('--- notes ---'); for (const n of notes.filter(n=>/imported|placed|navigation|restored|Could not/.test(n)).slice(-8)) console.log(' ', n)
await shot('/tmp/wts-import.png')
cdp.close(); await closeTab(tab.id)
