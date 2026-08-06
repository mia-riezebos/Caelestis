import { Session, closeTab, newTab, sleep } from './cdp.mjs'
const tab = await newTab('about:blank')
const cdp = await Session.attach(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'https://wplace.live/?lat=52.429222&lng=5.009766&zoom=11' })
await cdp.waitFor((m) => m.method === 'Page.loadEventFired', { timeout: 60_000, label: 'load' })
await sleep(11_000)
// Tailwind ships only the classes a site actually uses. Anything we invent may simply not exist in
// wplace's stylesheet — so test every class we rely on against the live page.
const out = await cdp.evaluate(`(() => {
  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const test = (cls, prop) => {
    probe.className = ''
    const before = getComputedStyle(probe)[prop]
    probe.className = cls
    const after = getComputedStyle(probe)[prop]
    return before !== after
  }
  const checks = [
    ['fixed','position'], ['absolute','position'], ['relative','position'],
    ['right-16','right'], ['right-4','right'], ['top-4','top'], ['bottom-4','bottom'],
    ['w-80','width'], ['w-full','width'], ['z-40','zIndex'],
    ['flex','display'], ['flex-col','flexDirection'], ['grow','flexGrow'],
    ['overflow-y-auto','overflowY'], ['min-h-0','minHeight'],
    ['bg-base-100','backgroundColor'], ['text-base-content','color'],
    ['border','borderTopWidth'], ['border-base-300','borderTopColor'],
    ['rounded-box','borderRadius'], ['shadow-xl','boxShadow'], ['shadow-md','boxShadow'],
    ['px-3','paddingLeft'], ['py-2','paddingTop'], ['gap-2','gap'],
    ['text-sm','fontSize'], ['text-xs','fontSize'], ['font-semibold','fontWeight'],
    ['opacity-60','opacity'], ['uppercase','textTransform'], ['tracking-wide','letterSpacing'],
    ['items-center','alignItems'], ['justify-between','justifyContent'],
    ['max-w-64','maxWidth'], ['size-5','width'], ['size-10','width'],
  ]
  const missing = checks.filter(([c, p]) => !test(c, p)).map(([c]) => c)
  const present = checks.filter(([c, p]) => test(c, p)).map(([c]) => c)
  probe.remove()
  return { missing, presentCount: present.length, present }
})()`)
console.log('MISSING from wplace CSS:', JSON.stringify(out.missing))
console.log('present:', out.presentCount, 'of', out.missing.length + out.presentCount)
cdp.close(); await closeTab(tab.id)
