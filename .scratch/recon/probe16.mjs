import { readFileSync, writeFileSync } from 'node:fs'
import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const bundle = readFileSync('apps/userscript/dist/wplace-template-server.user.js', 'utf8')
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `if (/^https:\\/\\/wplace\\.live\\//.test(location.href)) {\n${bundle}\n}`,
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(12_000)

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 })
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(name, Buffer.from(data, 'base64'))
}

await shot('/tmp/wts-pan-0-before.png')
// Hold the drag partway and screenshot without releasing: mid-motion is where a frame of lag shows.
await mouse('mousePressed', 850, 420)
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', 850 - i * 40, 420 + i * 14); await sleep(50) }
await shot('/tmp/wts-pan-1-during.png')
for (let i = 7; i <= 10; i++) { await mouse('mouseMoved', 850 - i * 40, 420 + i * 14); await sleep(50) }
await mouse('mouseReleased', 450, 560)
await sleep(2_500)
await shot('/tmp/wts-pan-2-after.png')
console.log('captured before / during / after')
cdp.close(); await closeTab(tab.id)
