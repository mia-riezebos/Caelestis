import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable')
await cdp.send('Log.enable').catch(() => {})
const notes = []
cdp.on((m) => {
  if (m.method === 'Network.loadingFailed') notes.push(`FAILED ${m.params.errorText} blocked=${m.params.blockedReason ?? '-'} cors=${JSON.stringify(m.params.corsErrorStatus ?? null)}`)
  if (m.method === 'Log.entryAdded') notes.push(`LOG[${m.params.entry.level}] ${m.params.entry.text.slice(0, 160)}`)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    notes.push('CONSOLE ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160))
})
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(9_000)
notes.length = 0
const attempt = async (u) => {
  const r = await cdp.evaluate(`(async () => {
    try { const res = await fetch(${JSON.stringify(u)}); return 'ok ' + res.status }
    catch (e) { return 'threw: ' + e.message }
  })()`)
  await sleep(900)
  return r
}
for (const u of ['http://127.0.0.1:8787/server', 'http://localhost:8787/server']) {
  console.log(u, '->', await attempt(u))
}
console.log('\nbrowser-side notes:')
for (const n of [...new Set(notes)]) console.log(' ', n)
cdp.close(); await closeTab(tab.id)
