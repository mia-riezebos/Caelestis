import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

/** Reserve an available loopback port for a test server or kubectl forwarder. */
export const availablePort = () =>
  new Promise((done, reject) => {
    const socket = createServer().listen(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => done(port))
    })
    socket.on('error', reject)
  })

/** Capture command output without blocking the test client's event loop. */
export function start(command, args, { log, ...options }) {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const completion = once(child, 'exit')
  // The caller observes startup failures through wait(); avoid an unhandled rejection meanwhile.
  completion.catch(() => {})
  return {
    async wait() {
      const [code, signal] = await completion
      if (code !== 0) throw new Error(`${command} exited ${code ?? signal}; see ${log}`)
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      process.kill(-child.pid, 'SIGTERM')
      const deadline = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }, 10_000)
      try {
        await completion
      } finally {
        clearTimeout(deadline)
      }
    },
  }
}

/** Run a finite provisioning command and keep its diagnostics. */
export async function run(command, args, options) {
  const child = start(command, args, options)
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    void child.stop()
  }, options.timeout ?? 240_000)
  try {
    await child.wait()
    if (timedOut) throw new Error(`${command} timed out; see ${options.log}`)
  } finally {
    clearTimeout(deadline)
  }
}
