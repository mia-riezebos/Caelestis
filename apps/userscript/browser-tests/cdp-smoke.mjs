import { readFile } from 'node:fs/promises'

const port = process.env.CDP_PORT ?? '9222'
const bundle = process.env.BROWSER_BUNDLE
if (bundle === undefined) throw new Error('BROWSER_BUNDLE is required')
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
  response.json(),
)
const target = targets.find((candidate) => candidate.type === 'page')
if (target === undefined) throw new Error('CDP has no page target')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const calls = new Map()
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const response = JSON.parse(data)
  if (response.id !== undefined) calls.get(response.id)?.(response)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    calls.set(id, (response) => {
      calls.delete(id)
      if (response.error !== undefined) reject(new Error(response.error.message))
      else resolve(response.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })

try {
  await call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await call('Page.enable')
  await call('Page.navigate', { url: 'about:blank' })
  await call('Runtime.evaluate', { expression: await readFile(bundle, 'utf8') })
  const result = await call('Runtime.evaluate', {
    expression: 'runProductionBrowserBoundaries()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
  if (result.result.value?.canvasCaptured !== true || result.result.value?.scans?.length !== 3)
    throw new Error('production browser contracts returned an incomplete result')
} finally {
  socket.close()
}

console.log('production CDP browser contracts passed')
