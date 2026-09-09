import { spawn } from 'node:child_process'

/** Run a local server and its named tunnel, waiting for readiness and stopping both together. */
export async function runDevWithTunnel({
  cwd,
  label,
  command,
  args,
  healthUrl,
  tunnelName,
  hostname,
}) {
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
      cwd,
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
      `[tunnel] The server is up without a tunnel. Install and authenticate cloudflared, and ensure ` +
        `the named tunnel "${tunnelName}" exists, then restart this task.`,
    )
  }

  process.once('SIGINT', () => shutDown('SIGINT', 130))
  process.once('SIGTERM', () => shutDown('SIGTERM', 143))

  worker = startChild(label, command, args)
  worker.on('error', (error) => {
    console.error(`[${label}] Could not start server: ${error.message}`)
    workerExited = true
    if (!shuttingDown) shutDown('SIGTERM', 1)
    maybeFinish()
  })
  worker.on('exit', (code, signal) => {
    workerExited = true
    if (!shuttingDown) {
      const result = signal ? `signal ${signal}` : `code ${code}`
      console.error(`[${label}] Server exited with ${result}.`)
      shutDown('SIGTERM', code ?? 1)
    }
    maybeFinish()
  })

  const waitForServer = async () => {
    while (!shuttingDown && running(worker)) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) })
        if (response.ok) return true
      } catch {
        // The server is still booting. The next poll will try again.
      }
      await sleep(250)
    }
    return false
  }

  if (await waitForServer()) {
    console.log('[tunnel] Server health check passed; starting the named tunnel.')
    console.log(`[tunnel] Public hostname: https://${hostname}`)

    tunnelExited = false
    tunnel = startChild(
      'tunnel',
      'cloudflared',
      ['tunnel', 'run', '--url', new URL(healthUrl).origin, tunnelName],
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
          console.error(`[tunnel] Tunnel exited with ${result}; stopping server.`)
          shutDown('SIGTERM', code ?? 1)
        }
      }
      maybeFinish()
    })
  }

  process.exitCode = await finished
}
