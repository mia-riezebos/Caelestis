import { AsyncLocalStorage } from 'node:async_hooks'
import { type WebSocket, WebSocketServer } from 'ws'
import type { CoordinatorStorage } from '../coordination/database.js'
import {
  type LiveHost,
  type LiveSocket,
  MAX_LIVE_CLIENT_BINARY_BYTES,
  type StatusCoordinator,
} from '../status-coordinator.js'

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 10000
export interface LiveUpgradeContext {
  accept?: (socket: WebSocket) => void
}
export const liveRequestContext = new AsyncLocalStorage<LiveUpgradeContext>()

/** Bound the initial handshake buffer and slow-client output before handing messages to ws. */
class NodeLiveSocket implements LiveSocket {
  private attachment: unknown = null
  private socket: WebSocket | undefined
  private buffered: (string | ArrayBuffer | ArrayBufferView)[] = []
  private bufferedBytes = 0
  private closed: { code: number; reason: string } | undefined
  private readonly timeout: ReturnType<typeof setTimeout>
  constructor(private readonly remove: () => void) {
    this.timeout = setTimeout(() => this.close(1013, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS)
    this.timeout.unref()
  }
  attach(socket: WebSocket): void {
    clearTimeout(this.timeout)
    this.socket = socket
    if (this.closed) {
      socket.close(this.closed.code, this.closed.reason)
      return
    }
    const buffered = this.buffered
    this.buffered = []
    this.bufferedBytes = 0
    for (const message of buffered) this.send(message)
  }
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return
    const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
    const waiting = this.socket?.bufferedAmount ?? this.bufferedBytes
    if (waiting + size > MAX_BUFFERED_BYTES) {
      this.close(1013, 'client is too slow')
      return
    }
    if (this.socket)
      this.socket.send(
        message instanceof ArrayBuffer || typeof message === 'string'
          ? message
          : new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice(),
      )
    else {
      this.buffered.push(message)
      this.bufferedBytes += size
    }
  }
  close(code = 1000, reason = ''): void {
    clearTimeout(this.timeout)
    this.closed ??= { code, reason }
    this.buffered = []
    this.remove()
    this.socket?.close(code, reason)
  }
  serializeAttachment(attachment: unknown): void {
    this.attachment = structuredClone(attachment)
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment)
  }
}

/** Node transport preserves the shared coordinator's auth, capacity, and attachment contracts. */
export class NodeLiveHost implements LiveHost<NodeLiveSocket> {
  private readonly sockets = new Set<NodeLiveSocket>()
  private readonly pending = new Set<Promise<void>>()
  private stopping = false
  constructor(
    readonly storage: CoordinatorStorage,
    private readonly coordinator: () => StatusCoordinator<NodeLiveSocket>,
  ) {}
  getWebSockets(): readonly LiveSocket[] {
    return [...this.sockets]
  }
  connect(attachment: unknown) {
    const socket = new NodeLiveSocket(() => this.sockets.delete(socket))
    socket.serializeAttachment(attachment)
    this.sockets.add(socket)
    return { client: socket, server: socket }
  }
  async upgradeResponse(socket: NodeLiveSocket, headers: Headers): Promise<Response> {
    const context = liveRequestContext.getStore()
    if (!context) {
      socket.close(1011, 'missing upgrade context')
      throw new Error('Missing Node upgrade context')
    }
    context.accept = (ws) => {
      let pending = Promise.resolve()
      let queuedBytes = 0
      ws.on('message', (data, binary) => {
        if (this.stopping) return
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        queuedBytes += bytes.length
        if (queuedBytes > MAX_BUFFERED_BYTES) {
          socket.close(1013, 'client sends too quickly')
          return
        }
        const message = binary ? Uint8Array.from(bytes).buffer : bytes.toString('utf8')
        pending = pending
          .then(() => this.coordinator().webSocketMessage(socket, message))
          .catch((error: unknown) => {
            console.error('Live message failed', error)
            socket.close(1011, 'live message failed')
          })
          .finally(() => {
            queuedBytes -= bytes.length
          })
        const work = pending
        this.pending.add(work)
        void work.finally(() => this.pending.delete(work))
      })
      ws.on('close', () => socket.close())
      ws.on('error', (error) => {
        console.error('Live socket failed', error)
        socket.close(1011, 'live socket failed')
      })
      socket.attach(ws)
    }
    return new Response(null, { headers })
  }
  async close(): Promise<void> {
    this.stopping = true
    for (const socket of this.sockets) socket.close(1001, 'server shutting down')
    await Promise.all(this.pending)
  }
}

export const createWebSocketServer = (
  protocol: (request: import('node:http').IncomingMessage) => string | false,
) =>
  new WebSocketServer({
    noServer: true,
    maxPayload: MAX_LIVE_CLIENT_BINARY_BYTES,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => protocol(request),
  })
