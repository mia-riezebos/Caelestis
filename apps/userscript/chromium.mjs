/**
 * Make sure a Chromium with the CDP port open is running, and start one if not.
 *
 *   node apps/userscript/chromium.mjs             # ensure it is up, then exit
 *   node apps/userscript/chromium.mjs --relaunch  # quit an already-running Chromium first
 *
 * Also used by `dev-inject.mjs`, so injecting no longer needs a browser started by hand.
 *
 * **The debugging port can only be set at launch.** There is no way to enable it on a browser that
 * is already running, which is the whole awkwardness here: if Chromium is up *without* the port, the
 * only remedy is to quit and start it again. `open -a Chromium --args` does not help — when the app
 * is already running it just brings it to the front and silently drops the arguments, so the next
 * connection fails with a timeout that says nothing about why.
 *
 * **Chromium uses the default profile deliberately.** A throwaway profile is signed out of wplace,
 * so it cannot read `/me`, where owned colours come from. Official Google Chrome no longer permits
 * remote debugging of its default data directory, so that fallback uses one persistent Caelestis
 * profile instead; sign into wplace there once and later runs retain the session.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'
const PORT_ARG = '--remote-debugging-port=9222'
const CHROME_PROFILE_ARG = `--user-data-dir=${join(homedir(), '.caelestis-chrome-debug')}`
/**
 * How to recognise a running browser.
 *
 * On Linux this is matched against the process *name* rather than the whole command line. `-f` and
 * a bare alternation matched anything whose arguments merely mentioned Chromium — an editor with a
 * file open, a shell in a directory called `chromium`, and this script itself, whose own path ends
 * in `chromium.mjs`. `--relaunch` then killed the run that issued it.
 */
const PROCESS_PATTERN =
  process.platform === 'darwin'
    ? 'Chromium.app/Contents/MacOS/Chromium'
    : '(chromium|chromium-browser|google-chrome|chrome)'
const MATCH_ARGS = process.platform === 'darwin' ? ['-f'] : ['-x']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether something is answering CDP on the port. */
export const cdpReady = async () => {
  try {
    const response = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return null
    const body = await response.json()
    return body.Browser ?? 'unknown'
  } catch {
    return null
  }
}

const run = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

/**
 * Start a browser and let go of it.
 *
 * `open -a` on macOS returns as soon as the app is asked to start, but a Linux `chromium` stays in
 * the foreground for the whole session — awaiting its exit meant the script hung until the user
 * closed the browser it had just opened. Success here is "the process started", and the port check
 * that follows is what decides whether it worked.
 */
const launch = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => resolve(false))
    child.on('spawn', () => {
      child.unref()
      resolve(true)
    })
  })

const output = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args)
    let text = ''
    child.stdout?.on('data', (chunk) => {
      text += chunk
    })
    child.on('exit', () => resolve(text.trim()))
    child.on('error', () => resolve(''))
  })

/** A Chromium process that is not ours, i.e. one started without the port. */
const runningWithoutPort = async () => {
  const found = await output('pgrep', [...MATCH_ARGS, PROCESS_PATTERN])
  return found !== ''
}

/**
 * Launch commands to try, most specific first.
 *
 * macOS goes through `open` so the app bundle is started the way the Finder would, which keeps it a
 * normal foreground app rather than a headless-looking child of this script.
 */
export const launchersFor = (platform = process.platform) =>
  platform === 'darwin'
    ? [['open', ['-a', 'Chromium', '--args', PORT_ARG]]]
    : [
        ['chromium', [PORT_ARG]],
        ['chromium-browser', [PORT_ARG]],
        // Chrome 136+ ignores remote-debugging switches against its default data directory.
        ['google-chrome', [PORT_ARG, CHROME_PROFILE_ARG]],
      ]

const LAUNCHERS = launchersFor()

/** @internal The `--relaunch` contract deliberately bypasses an otherwise reusable CDP session. */
export const mayReuseExistingBrowser = (already, relaunch) => already !== null && !relaunch

export const ensureChromium = async ({ relaunch = false, quiet = false } = {}) => {
  const already = await cdpReady()
  if (mayReuseExistingBrowser(already, relaunch)) {
    if (!quiet) console.log(`chromium already listening on 9222 (${already})`)
    return true
  }

  if (relaunch) {
    if (!quiet) console.log('quitting the running Chromium so it can be started with the port…')
    if (process.platform === 'darwin') {
      await run('osascript', ['-e', 'tell application "Chromium" to quit'])
    } else {
      await run('pkill', [...MATCH_ARGS, PROCESS_PATTERN])
    }
    // Quitting is not instant, and relaunching too early gets the arguments dropped again.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await runningWithoutPort())) break
      await sleep(250)
    }
  }

  // Launch unconditionally rather than checking first whether Chromium is running.
  //
  // Asking "is it running?" and treating yes as fatal was both unnecessary and unreliable: a browser
  // that has just been told to quit still shows up for a while, so a cold start could be reported as
  // "already running without the port" and refuse to do the very thing that would have worked.
  // Launching is harmless in every state — `open -a` on a running app just focuses it — so try it
  // and let the port decide.
  let launched = false
  for (const [command, args] of LAUNCHERS) {
    if (await launch(command, args)) {
      launched = true
      break
    }
  }
  if (!launched) throw new Error('could not launch Chromium — is it installed?')

  for (let attempt = 0; attempt < 60; attempt++) {
    const version = await cdpReady()
    if (version !== null) {
      if (!quiet) console.log(`chromium started on 9222 (${version})`)
      return true
    }
    await sleep(250)
  }

  // The port never came up. If a Chromium is running, this is the one situation that cannot be
  // fixed from here, and it is worth saying so precisely rather than reporting a timeout.
  if (await runningWithoutPort()) {
    const restart =
      process.platform === 'darwin'
        ? `  osascript -e 'tell application "Chromium" to quit'\n  open -a Chromium --args ${PORT_ARG}`
        : `  pkill -x '${PROCESS_PATTERN}'\n  chromium ${PORT_ARG}\n` +
          `  # Google Chrome instead:\n  google-chrome ${PORT_ARG} ${CHROME_PROFILE_ARG}`
    throw new Error(
      'Chromium is already running without the debugging port, and the port can only be set at\n' +
        'launch — the arguments are dropped when the app is already open. Pass --relaunch to quit\n' +
        `and restart it, or do it yourself:\n${restart}`,
    )
  }
  throw new Error('Chromium was launched but never opened the debugging port')
}

// Run directly to just make sure a debuggable browser exists.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await ensureChromium({ relaunch: process.argv.includes('--relaunch') })
  } catch (error) {
    // The message is the whole point here — it says what to do. A stack trace to this file's own
    // throw site tells the reader nothing and buries it.
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
