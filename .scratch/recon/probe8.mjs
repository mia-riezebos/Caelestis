import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const run = async (bypassSW) => {
  const tab = await newTab('about:blank')
  const cdp = await Session.attach(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable')
  if (bypassSW) await cdp.send('Network.setBypassServiceWorker', { bypass: true })
  await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=-79.9564936&lng=-1.5093457&zoom=11.3' })
  await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
  await sleep(8_000)
  const out = await cdp.evaluate(`(async () => {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : []
    const one = async (u) => { const r = await fetch(u)
      return { status: r.status, bytes: (await r.arrayBuffer()).byteLength } }
    const B = 'https://backend.wplace.live/files/s0/tiles/'
    return {
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      swScripts: regs.map(r => (r.active||r.installing||r.waiting||{}).scriptURL).filter(Boolean),
      emptyInRange: await one(B + '1015/1816.png'),
      painted:      await one(B + '325/1782.png'),
      outOfRange:   await one(B + '2048/1782.png'),
    }
  })()`)
  cdp.close(); await closeTab(tab.id)
  return out
}
console.log('SW ACTIVE      :', JSON.stringify(await run(false), null, 1))
console.log('SW BYPASSED    :', JSON.stringify(await run(true), null, 1))
