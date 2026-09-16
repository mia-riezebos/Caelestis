import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const profile = await mkdtemp(join(tmpdir(), 'caelestis-browser-test-'))
const artifacts = await mkdtemp(join(tmpdir(), 'caelestis-browser-artifacts-'))
const bundle = join(artifacts, 'production-boundaries.js')
const executable =
  process.env.CHROMIUM_PATH ??
  (process.platform === 'darwin'
    ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
    : 'chromium')
let browser
let check
let startupError
let stopping
const stop = () =>
  (stopping ??= (async () => {
    for (const child of [check, browser]) {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    await Promise.all(
      [profile, artifacts].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }),
      ),
    )
  })())
const interrupt = () => {
  void stop().finally(() => process.exit(130))
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  await build({
    entryPoints: ['browser-tests/production-boundaries.ts'],
    outfile: bundle,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    logLevel: 'silent',
  })
  browser = spawn(
    executable,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  )
  browser.once('error', (error) => {
    startupError = error
  })
  const deadline = Date.now() + 10000
  let port
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    if (browser.exitCode !== null) throw new Error(`Chromium exited ${browser.exitCode}`)
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      if (/^\d+$/.test(port)) break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!port) throw new Error('Disposable Chromium did not expose its CDP port')
  check = spawn(process.execPath, ['browser-tests/cdp-smoke.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CDP_PORT: port, BROWSER_BUNDLE: bundle },
    stdio: 'inherit',
  })
  const [code] = await once(check, 'exit')
  if (code !== 0) throw new Error(`Production browser contracts exited ${code}`)
} finally {
  await stop()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
