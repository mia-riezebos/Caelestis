/**
 * Keep the local Worker and its named Cloudflare tunnel together in one Turbo task.
 *
 * The tunnel waits for the health endpoint because starting it first exposes a public route that
 * can only return 502s while Wrangler is still booting. The tunnel is a convenience for local
 * development rather than a prerequisite for the Worker, so missing credentials, a missing named
 * tunnel, or an unavailable cloudflared binary is reported clearly without taking the Worker down.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HEALTH_URL = 'http://127.0.0.1:8787/backend/health'
const TUNNEL = process.env.CAELESTIS_TUNNEL ?? 'caelestis-dev'
const WRANGLER = join(here, 'node_modules', '.bin', 'wrangler')
const FORCE_KILL_AFTER_MS = 5_000

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const prefixLines = (stream, prefix, output, onLine = () => {}) => {
  let pending = ''

  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      output.write(`${prefix} ${line}\n`)
      onLine(line)
    }
  })
  stream.on('end', () => {
    if (pending) {
      output.write(`${prefix} ${pending}\n`)
      onLine(pending)
    }
  })
}

const startChild = (label, command, args, onLine) => {
  const child = spawn(command, args, {
    cwd: here,
    detached: true,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  prefixLines(child.stdout, `[${label}]`, process.stdout, onLine)
  prefixLines(child.stderr, `[${label}]`, process.stderr, onLine)
  return child
}

let worker
let tunnel
let workerExited = false
let tunnelExited = true
let tunnelConnected = false
let tunnelSkipped = false
let shuttingDown = false
let exitCode = 0
let finish

const finished = new Promise((resolve) => {
  finish = resolve
})

const running = (child) => child && child.exitCode === null && child.signalCode === null

const signalGroup = (child, signal) => {
  if (!child?.pid) return false

  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    return false
  }
}

const stop = (child, signal) => {
  if (!running(child) || !signalGroup(child, signal)) return

  const timer = setTimeout(() => {
    signalGroup(child, 'SIGKILL')
  }, FORCE_KILL_AFTER_MS)
  timer.unref()
  child.once('close', () => {
    clearTimeout(timer)
  })
}

const maybeFinish = () => {
  if (workerExited && (!tunnel || tunnelExited)) finish(exitCode)
}

const shutDown = (signal = 'SIGTERM', code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  exitCode = code
  stop(worker, signal)
  stop(tunnel, signal)
  maybeFinish()
}

const skipTunnel = () => {
  if (tunnelSkipped || shuttingDown) return
  tunnelSkipped = true
  console.error(
    `[tunnel] The worker is up without a tunnel. Install and authenticate cloudflared, and ensure ` +
      `the named tunnel "${TUNNEL}" exists, then restart this task.`,
  )
}

process.once('SIGINT', () => shutDown('SIGINT', 130))
process.once('SIGTERM', () => shutDown('SIGTERM', 143))

worker = startChild('wrangler', WRANGLER, ['dev', '--port', '8787'])
worker.on('error', (error) => {
  console.error(`[wrangler] Could not start Wrangler: ${error.message}`)
  workerExited = true
  if (!shuttingDown) shutDown('SIGTERM', 1)
  maybeFinish()
})
worker.on('exit', (code, signal) => {
  workerExited = true
  if (!shuttingDown) {
    const result = signal ? `signal ${signal}` : `code ${code}`
    console.error(`[wrangler] Wrangler exited with ${result}.`)
    shutDown('SIGTERM', code ?? 1)
  }
  maybeFinish()
})

const waitForWorker = async () => {
  while (!shuttingDown && running(worker)) {
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return true
    } catch {
      // Wrangler is still booting. The next poll will try again.
    }
    await sleep(250)
  }
  return false
}

if (await waitForWorker()) {
  console.log('[tunnel] Worker health check passed; starting the named tunnel.')
  if (TUNNEL === 'caelestis-dev') {
    console.log('[tunnel] Public hostname: https://caelestis-dev.mia.cx')
  }

  tunnelExited = false
  tunnel = startChild(
    'tunnel',
    'cloudflared',
    ['tunnel', 'run', '--url', 'http://localhost:8787', TUNNEL],
    (line) => {
      if (/registered tunnel connection/i.test(line)) tunnelConnected = true
    },
  )
  tunnel.on('error', () => {
    tunnelExited = true
    skipTunnel()
    maybeFinish()
  })
  tunnel.on('exit', (code, signal) => {
    tunnelExited = true
    if (!shuttingDown) {
      if (!tunnelConnected) {
        skipTunnel()
      } else {
        const result = signal ? `signal ${signal}` : `code ${code}`
        console.error(`[tunnel] Tunnel exited with ${result}; stopping Wrangler.`)
        shutDown('SIGTERM', code ?? 1)
      }
    }
    maybeFinish()
  })
}

process.exitCode = await finished
