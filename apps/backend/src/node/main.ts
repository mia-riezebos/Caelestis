import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { nodeObjectStorage } from '@caelestis/storage/node'
import { S3ObjectStorage } from '@caelestis/storage/s3'
import { readNodeConfig } from './config.js'
import { openNodeRuntime } from './runtime.js'
import { type FrontendHandler, listenNodeServer } from './server.js'

const config = readNodeConfig()
const objects = nodeObjectStorage(process.env)
let close: (() => Promise<void>) | undefined
let closing = false
let ownershipFailure: Error | undefined
const shutdown = async (error?: Error) => {
  if (closing) return
  closing = true
  if (error) {
    console.error('Runtime ownership lost', error)
    process.exitCode = 1
  }
  const deadline = setTimeout(() => process.exit(1), 30000)
  deadline.unref()
  try {
    await close?.()
  } finally {
    if (objects instanceof S3ObjectStorage) objects.close()
    clearTimeout(deadline)
  }
}
try {
  let listeningPort = config.port
  const runtime = await openNodeRuntime(config, objects, {
    onOwnershipLost: (error) => {
      ownershipFailure = error
      void shutdown(error)
    },
    refreshSocial: () =>
      new Promise<void>((resolveJob, rejectJob) => {
        const worker = new Worker(pathToFileURL(resolve('scripts/social-refresh-worker.mjs')), {
          workerData: {
            site: `http://127.0.0.1:${listeningPort}`,
            output: resolve(process.env.DATA_DIRECTORY ?? './data', 'social-cache'),
          },
        })
        worker.once('error', rejectJob)
        worker.once('exit', (code) =>
          code === 0
            ? resolveJob()
            : rejectJob(new Error(`Social refresh worker exited with ${code}`)),
        )
      }),
  })
  close = () => runtime.close()
  if (ownershipFailure) {
    await runtime.close()
    throw ownershipFailure
  }
  if (process.argv.includes('migrate')) {
    await shutdown()
    console.info('Database migrations applied')
  } else {
    const module: { handler: FrontendHandler } = await import(
      pathToFileURL(resolve(process.env.FRONTEND_HANDLER ?? 'apps/frontend/build/handler.js')).href
    )
    const server = await listenNodeServer(runtime, config, module.handler)
    if (ownershipFailure) {
      await server.close()
      throw ownershipFailure
    }
    listeningPort = server.port
    close = () => server.close()
    process.once('SIGTERM', () => {
      void shutdown()
    })
    process.once('SIGINT', () => {
      void shutdown()
    })
    console.info(
      JSON.stringify({
        event: 'listening',
        host: config.host,
        port: server.port,
        database: config.adapter,
        objectStorage: process.env.OBJECT_STORAGE ?? 'filesystem',
        serverId: runtime.serverId,
      }),
    )
  }
} catch (error) {
  await shutdown()
  throw error
}
