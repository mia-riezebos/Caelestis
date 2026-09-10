import { resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
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
  let rendererReadToken: string | undefined
  const runtime = await openNodeRuntime(config, objects, {
    onOwnershipLost: (error) => {
      ownershipFailure = error
      void shutdown(error)
    },
    refreshSocial: () =>
      new Promise<void>((resolveJob, rejectJob) => {
        const worker = new Worker(new URL('./social-worker.js', import.meta.url), {
          workerData: {
            site: `http://127.0.0.1:${listeningPort}`,
            apiPath: `${config.basePath}/v1/`,
            readToken: rendererReadToken,
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
  rendererReadToken = runtime.readToken
  if (ownershipFailure) {
    await runtime.close()
    throw ownershipFailure
  }
  if (process.argv.includes('migrate')) {
    await shutdown()
    console.info('Database migrations applied')
  } else {
    const module: { handler: FrontendHandler } | undefined = process.env.FRONTEND_HANDLER
      ? await import(pathToFileURL(resolve(process.env.FRONTEND_HANDLER)).href)
      : undefined
    const server = await listenNodeServer(runtime, config, module?.handler)
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
