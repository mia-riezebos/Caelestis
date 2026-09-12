import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Serve SvelteKit and forward backend requests, including streaming WebSocket upgrades. */
export const createFrontendServer = (handler, { backend, readToken, objects }) => {
  const base = new URL(backend)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('CAELESTIS_SERVER must be an HTTP(S) backend URL without credentials')
  if (!readToken?.trim()) throw new Error('CAELESTIS_READ_TOKEN is required')
  base.pathname = base.pathname.replace(/\/+$/, '')
  const transport = base.protocol === 'https:' ? httpsRequest : httpRequest
  const sockets = new Set()
  let stopping = false
  const target = (path) => {
    const url = new URL(base)
    const query = path.indexOf('?')
    url.pathname = base.pathname + (query === -1 ? path : path.slice(0, query))
    url.search = query === -1 ? '' : path.slice(query)
    return url
  }
  const proxy = (request, response, head) => {
    const publicRead = request.url.split('?')[0] === '/api/v1/telemetry/live'
    const url = target(request.url.slice(publicRead ? '/api'.length : '/backend'.length))
    const headers = { ...request.headers, host: url.host }
    delete headers.cookie
    if (publicRead) {
      headers.authorization = `Bearer ${readToken}`
      // The public read route must never forward a browser-supplied credential protocol.
      headers['sec-websocket-protocol'] = (headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => ['caelestis.live.v1', 'caelestis.live.v2'].includes(value))
        .join(', ')
    }
    const upstream = transport(url, { method: request.method, headers })
    const failed = () => {
      if (head !== undefined) response.destroy()
      else if (!response.headersSent) response.writeHead(502).end('Backend unavailable')
      else response.destroy()
    }
    upstream.on('error', failed)
    upstream.on('response', (received) => {
      if (head !== undefined) {
        response.end(
          `HTTP/1.1 ${received.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        )
        received.resume()
        return
      }
      response.writeHead(received.statusCode, received.headers)
      received.on('error', failed)
      received.pipe(response)
    })
    if (head !== undefined) {
      upstream.setTimeout(15_000, () => upstream.destroy())
      upstream.on('upgrade', (received, socket, upstreamHead) => {
        socket.setTimeout(0)
        sockets.add(socket)
        socket.on('close', () => {
          sockets.delete(socket)
          response.destroy()
        })
        socket.on('error', () => response.destroy())
        response.on('error', () => socket.destroy())
        response.on('close', () => socket.destroy())
        const rawHeaders = received.rawHeaders.reduce(
          (lines, value, i, all) => (i % 2 === 0 ? `${lines}${value}: ${all[i + 1]}\r\n` : lines),
          '',
        )
        response.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaders}\r\n`)
        if (upstreamHead.length) response.write(upstreamHead)
        if (head.length) socket.write(head)
        socket.pipe(response).pipe(socket)
      })
      response.once('close', () => upstream.destroy())
      upstream.end()
    } else {
      response.once('close', () => upstream.destroy())
      request.pipe(upstream)
    }
  }
  const server = createServer((request, response) => {
    if (stopping) {
      response.writeHead(503).end()
      return
    }
    const pathname = request.url.split('?')[0]
    if (pathname === '/health/live') {
      response.end('ok')
      return
    }
    if (pathname === '/health/ready') {
      void fetch(target('/v1/manifest'), {
        headers: { authorization: `Bearer ${readToken}` },
        signal: AbortSignal.timeout(4000),
      })
        .then(async (result) => {
          await result.body?.cancel()
          response.writeHead(result.ok ? 200 : 503).end()
        })
        .catch(() => response.writeHead(503).end())
      return
    }
    if (pathname === '/backend' || pathname.startsWith('/backend/')) {
      proxy(request, response)
      return
    }
    request.caelestis = {
      env: { CAELESTIS_SERVER: base.href, CAELESTIS_READ_TOKEN: readToken },
      objectStorage: objects,
    }
    const failed = (error) => {
      if (error) console.error('Frontend request failed', error)
      if (!response.headersSent) response.writeHead(error ? 500 : 404)
      response.end()
    }
    try {
      Promise.resolve(handler(request, response, failed)).catch(failed)
    } catch (error) {
      failed(error)
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url.split('?')[0]
    if (stopping || !(pathname.startsWith('/backend/') || pathname === '/api/v1/telemetry/live')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    proxy(request, socket, head)
  })
  return {
    server,
    async close() {
      stopping = true
      const deadline = setTimeout(() => {
        for (const socket of sockets) socket.destroy()
      }, 5000)
      deadline.unref()
      try {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      } finally {
        clearTimeout(deadline)
      }
    },
  }
}
