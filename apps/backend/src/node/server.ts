import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import type { NodeConfig } from './config.js'
import { createWebSocketServer, type LiveUpgradeContext, liveRequestContext } from './live.js'
import type { openNodeRuntime } from './runtime.js'

export type FrontendHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>
type Runtime = Awaited<ReturnType<typeof openNodeRuntime>>

/** Serve the backend, frontend, and authenticated WebSockets on one HTTP listener. */
export const listenNodeServer = async (
  runtime: Runtime,
  config: NodeConfig,
  frontend?: FrontendHandler,
) => {
  let stopping = false
  const backendFetch = (request: Request) => {
    const url = new URL(request.url)
    const mount = [config.basePath, '/backend'].find(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
    if (mount === undefined) return Promise.resolve(new Response('Not Found', { status: 404 }))
    url.pathname = url.pathname.slice(mount.length) || '/'
    return runtime.app.fetch(new Request(url, request))
  }
  const app = new Hono()
  app.all('*', async (context) => {
    if (stopping) return new Response('Server shutting down', { status: 503 })
    const request = context.req.raw
    const url = new URL(request.url)
    if (url.pathname === '/health/live') return Response.json({ ok: true })
    if (url.pathname === '/metrics') {
      const [failures, dropped, jobs] = await Promise.all([
        runtime.counters.readFlushFailureCount(),
        runtime.counters.readDroppedLateCount(),
        runtime.connection
          .prepare('SELECT COUNT(*) AS count FROM runtime_alarms')
          .first<{ count: number }>(),
      ])
      return new Response(
        `# TYPE caelestis_counter_flush_failures gauge\ncaelestis_counter_flush_failures ${failures}\n# TYPE caelestis_counter_dropped_deltas_total counter\ncaelestis_counter_dropped_deltas_total ${dropped}\n# TYPE caelestis_durable_jobs_pending gauge\ncaelestis_durable_jobs_pending ${jobs?.count ?? 0}\n`,
        { headers: { 'content-type': 'text/plain; version=0.0.4' } },
      )
    }
    if (url.pathname === '/health/ready') {
      try {
        await runtime.connection.prepare('SELECT 1').first()
        return Response.json({ ok: true })
      } catch {
        return Response.json({ ok: false }, { status: 503 })
      }
    }
    if (url.pathname === '/api/v1/telemetry/live') {
      url.pathname = `${config.basePath}/v1/telemetry/live`
      const headers = new Headers(request.headers)
      headers.delete('cookie')
      headers.set('authorization', `Bearer ${runtime.readToken}`)
      return backendFetch(new Request(url, { method: 'GET', headers }))
    }
    const startedAt = performance.now()
    const response = await backendFetch(request)
    console.info(
      JSON.stringify({
        event: 'request',
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    )
    return response
  })
  const backendListener = getRequestListener(app.fetch, { overrideGlobalObjects: false })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (
      stopping ||
      pathname.startsWith('/health/') ||
      pathname === '/metrics' ||
      pathname === '/backend' ||
      pathname.startsWith('/backend/') ||
      pathname === config.basePath ||
      pathname.startsWith(`${config.basePath}/`) ||
      !frontend
    ) {
      backendListener?.(request, response)
      return
    }
    const hostedRequest = Object.assign(request, {
      caelestis: {
        env: {
          CAELESTIS_READ_TOKEN: runtime.readToken,
          CAELESTIS_BACKEND: { fetch: backendFetch },
        },
        objectStorage: runtime.objects,
      },
    })
    const failed = (error?: unknown) => {
      if (error) console.error('Frontend request failed', error)
      if (!response.headersSent) response.writeHead(error ? 500 : 404)
      response.end(error ? 'Internal Server Error' : 'Not Found')
    }
    try {
      Promise.resolve(frontend(hostedRequest, response, failed)).catch(failed)
    } catch (error) {
      failed(error)
    }
  })
  const protocols = new WeakMap<IncomingMessage, string>()
  const sockets = createWebSocketServer((request) => protocols.get(request) ?? false)
  server.on('upgrade', (request, socket, head) => {
    const context: LiveUpgradeContext = {}
    void liveRequestContext
      .run(context, async () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const response = await app.fetch(
          new Request(new URL(request.url ?? '/', 'http://localhost'), { headers }),
        )
        if (response.status !== 200 || !context.accept) {
          socket.end(
            `HTTP/1.1 ${response.status === 200 ? 400 : response.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          )
          return
        }
        const protocol = response.headers.get('sec-websocket-protocol')
        if (protocol) protocols.set(request, protocol)
        const accept = context.accept
        sockets.handleUpgrade(request, socket, head, accept)
      })
      .catch((error: unknown) => {
        console.error('WebSocket upgrade failed', error)
        socket.destroy()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  runtime.scheduler.start()
  return {
    server,
    port: (server.address() as AddressInfo).port,
    async close() {
      if (stopping) return
      stopping = true
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      for (const socket of sockets.clients) socket.close(1001, 'server shutting down')
      const force = setTimeout(() => {
        for (const socket of sockets.clients) socket.terminate()
        if ('closeAllConnections' in server) server.closeAllConnections()
      }, 5000)
      force.unref()
      try {
        await closed
        await runtime.close()
      } finally {
        clearTimeout(force)
      }
    },
  }
}
