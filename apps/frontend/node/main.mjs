import { nodeObjectStorage } from '@caelestis/storage/node'
import { handler } from '../build/handler.js'
import { createFrontendServer } from './server.mjs'

const objects = nodeObjectStorage(process.env)
const { server, close } = createFrontendServer(handler, {
  backend: process.env.CAELESTIS_SERVER ?? 'http://backend:3000/backend',
  readToken: process.env.CAELESTIS_READ_TOKEN,
  objects,
})
const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
server.listen(port, process.env.HOST ?? '0.0.0.0')
let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  try {
    await close()
  } finally {
    objects.close?.()
  }
}
process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
